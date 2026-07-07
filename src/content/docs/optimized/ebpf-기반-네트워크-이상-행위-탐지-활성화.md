---
title: "eBPF 기반 네트워크 이상 행위 탐지를 활성화한다"
description: "Kubernetes의 표준 `NetworkPolicy`는 기본적으로 L3/L4 수준의 허용/차단에 초점을 둔다. 이 방식은 서비스 간 통신 경로를 제한하는 데 효과적이지만, 운영 중 사고가 발생했을 때 “어떤 Pod가 어느 서비스로 어떤 프로토콜과 경로를 사용해 통신했"
phase: "Optimized"
domain: "네트워크 보안"
difficulty: "★★★"
owner: "공통 (전체 실습)"
order: 30
sidebar:
  order: 30
---

## 왜 필요한가

Kubernetes의 표준 `NetworkPolicy`는 기본적으로 L3/L4 수준의 허용/차단에 초점을 둔다. 이 방식은 서비스 간 통신 경로를 제한하는 데 효과적이지만, 운영 중 사고가 발생했을 때 “어떤 Pod가 어느 서비스로 어떤 프로토콜과 경로를 사용해 통신했는지”를 빠르게 설명하기에는 한계가 있다.

EKS에서 기본으로 많이 사용하는 Amazon VPC CNI도 Pod 네트워크와 AWS VPC 통합에는 강점이 있지만, 애플리케이션 레벨의 흐름 관찰, DNS/FQDN 기반 egress 통제, HTTP method/path 단위 정책까지 다루려면 별도의 관찰성과 정책 엔진이 필요하다.

Cilium은 eBPF를 이용해 커널 레벨에서 네트워크 흐름을 관찰하고 정책을 집행한다. Hubble을 함께 활성화하면 Pod 간 flow, DNS 질의, HTTP 요청, drop verdict를 CLI와 UI에서 확인할 수 있다. 이를 통해 운영팀은 다음과 같은 질문에 더 빠르게 답할 수 있다.

- 침해된 Pod가 어느 Namespace와 Service로 접근했는가?
- 허용되지 않은 egress 시도가 있었는가?
- DNS 기반 우회나 외부 FQDN 접근이 발생했는가?
- 특정 HTTP method/path가 정책에 의해 허용 또는 차단되었는가?

이 항목은 운영 클러스터에 CNI 변경을 즉시 강제하는 것이 아니라, 신규 클러스터나 네트워크 스택 변경이 가능한 시점에 Cilium/Hubble 기반 관찰성과 정책 확장을 검토하고 실습하는 것을 목표로 한다.

## 수행 방법

**사전 조건**

- EKS 클러스터와 `kubectl` 접근 권한이 필요하다.
- Cilium CLI, Hubble CLI, Helm이 설치되어 있어야 한다.
- 기존 Amazon VPC CNI 운영 정책과 충돌하지 않도록 배포 모델을 먼저 결정해야 한다.
- 운영 환경에 바로 적용하지 말고 신규 클러스터 또는 실습 Namespace에서 검증한다.

### Step 1: Cilium 배포 모델을 결정한다

EKS에서는 크게 두 가지 배포 모델을 검토할 수 있다.

| 모델 | 사용 시점 | 고려 사항 |
| --- | --- | --- |
| Amazon VPC CNI + Cilium CNI chaining | 기존 VPC CNI IPAM과 운영 방식을 유지하면서 Cilium 정책/관찰성을 검증할 때 | CNI 교체 리스크가 낮지만 일부 기능은 제약될 수 있다. |
| Cilium CNI full replacement | 신규 클러스터이거나 네트워크 스택 변경을 수용할 수 있을 때 | Cilium 기능을 더 폭넓게 사용할 수 있지만 운영 변경 폭이 크다. |

이 실습에서는 기존 Amazon VPC CNI와의 충돌을 줄이기 위해 CNI chaining 방식을 기본으로 한다.

### Step 2: Cilium/Hubble Helm values를 준비한다

`eks-secure-infra` 실습 레포에는 다음 values 파일을 둔다.

```yaml
# manifests/labs/cilium-ebpf-observability/cilium-values.yaml
cni:
  chainingMode: aws-cni
  exclusive: false

enableIPv4Masquerade: false
routingMode: native

hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true
  metrics:
    enabled:
      - dns:query;ignoreAAAA
      - drop
      - tcp
      - flow
      - http

operator:
  replicas: 1
```

핵심은 Amazon VPC CNI와 함께 사용할 수 있도록 `chainingMode: aws-cni`를 지정하고, Hubble relay/UI/metrics를 활성화하는 것이다.

### Step 3: Cilium과 Hubble을 설치한다

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install cilium cilium/cilium \
  --version 1.19.4 \
  --namespace kube-system \
  --values manifests/labs/cilium-ebpf-observability/cilium-values.yaml
```

기존 Pod에는 CNI chaining 설정이 즉시 반영되지 않을 수 있다. 실습 환경에서는 영향 범위를 확인한 뒤 대상 workload를 재시작한다.

```bash
kubectl rollout restart deployment/web -n team-d
kubectl rollout restart deployment/api -n team-d
kubectl rollout restart statefulset/db -n team-d
```

### Step 4: 표준 NetworkPolicy부터 적용한다

먼저 표준 `NetworkPolicy`로 기본 deny와 필수 L4 흐름을 만든다. 이렇게 하면 Cilium 확장 정책을 사용하기 전에 Kubernetes 표준 정책으로 최소 통신 경계를 확인할 수 있다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

실습 레포 기준 적용 명령은 다음과 같다.

```bash
kubectl apply -k manifests/labs/cilium-ebpf-observability
```

### Step 5: DNS/FQDN 기반 CiliumNetworkPolicy를 적용한다

외부 egress를 IP 대역이 아니라 FQDN 단위로 제어해야 하는 경우 `CiliumNetworkPolicy`의 `toFQDNs`를 사용할 수 있다.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-web-dns-and-github-fqdn-egress
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/name: web
  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
          rules:
            dns:
              - matchPattern: "*"
    - toFQDNs:
        - matchName: api.github.com
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

이 정책은 `web` Pod가 DNS proxy를 통해 FQDN을 확인하고, 예시로 `api.github.com:443`만 외부 egress 대상으로 허용하도록 구성한다.

### Step 6: HTTP L7 정책을 적용한다

HTTP method/path 단위 통제가 필요한 경우 Cilium L7 정책을 사용한다.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-web-to-api-health-http
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/name: api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: web
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/healthz"
```

이 정책은 `api` workload로 들어오는 트래픽 중 `web` workload의 `GET /healthz` 요청만 허용하는 예시다.

## 검증 방법

### 1. 취약 상태를 확인한다

적용 전에는 Cilium/Hubble 또는 Cilium 정책 리소스가 없거나, flow 관찰이 되지 않는 상태일 수 있다.

```bash
cilium status
hubble status
hubble observe --namespace team-d
```

예상되는 취약 상태는 다음과 같다.

- `cilium status` 또는 `hubble status`가 실패한다.
- `hubble observe`로 `team-d` Namespace의 flow를 조회할 수 없다.
- Drop verdict, DNS query, HTTP flow를 한 곳에서 확인할 수 없다.

`CiliumNetworkPolicy` CRD와 정책 적용 여부도 확인한다.

```bash
kubectl get crd ciliumnetworkpolicies.cilium.io
kubectl get networkpolicy -n team-d
kubectl get ciliumnetworkpolicy -n team-d
```

미적용 상태에서는 `ciliumnetworkpolicies.cilium.io` CRD가 없거나, `team-d` Namespace에 DNS/FQDN/L7 정책이 없어야 한다.

정책이 없거나 제대로 집행되지 않으면 임의 테스트 Pod에서 내부 서비스와 외부 FQDN 접근이 넓게 성공할 수 있다.

```bash
kubectl -n team-d create deployment netshoot-before --image=nicolaka/netshoot -- sleep 3600
kubectl -n team-d wait --for=condition=available deployment/netshoot-before --timeout=60s

POD=$(kubectl -n team-d get pod -l app=netshoot-before -o jsonpath='{.items[0].metadata.name}')

kubectl -n team-d exec "$POD" -- nc -vz -w 3 api 80
kubectl -n team-d exec "$POD" -- nc -vz -w 3 db 6379
kubectl -n team-d exec "$POD" -- curl -I --max-time 5 https://example.com
```

취약한 상태에서는 허용 여부를 설명할 정책과 flow 기록 없이 연결이 성공할 수 있다.

### 2. Cilium/Hubble 설치 상태를 확인한다

```bash
cilium status
hubble status
```

기대 결과:

- Cilium agent와 operator가 정상 상태다.
- Hubble relay가 활성화되어 있다.
- Hubble UI를 사용할 수 있다.

Hubble UI는 다음 명령으로 연다.

```bash
cilium hubble ui
```

### 3. 정책 리소스가 적용되었는지 확인한다

```bash
kubectl get networkpolicy -n team-d
kubectl get ciliumnetworkpolicy -n team-d
kubectl describe ciliumnetworkpolicy -n team-d
```

기대 결과:

- `default-deny-ingress`, `default-deny-egress`, `allow-dns-egress` 같은 표준 `NetworkPolicy`가 존재한다.
- `allow-web-dns-and-github-fqdn-egress`, `allow-web-to-api-health-http` 같은 `CiliumNetworkPolicy`가 존재한다.

### 4. Hubble에서 flow와 drop verdict를 확인한다

```bash
hubble observe --namespace team-d
hubble observe --namespace team-d --protocol http
hubble observe --namespace team-d --verdict DROPPED
```

기대 결과:

- `web`, `api`, `db` 간 허용 flow가 조회된다.
- 허용되지 않은 egress 또는 HTTP path는 `DROPPED` verdict로 관찰된다.
- DNS 질의와 HTTP 요청이 flow 이벤트로 남는다.

### 5. DNS/FQDN 정책을 검증한다

```bash
WEB_POD=$(kubectl get pod -n team-d -l app.kubernetes.io/name=web -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n team-d "$WEB_POD" -- curl -I --max-time 5 https://api.github.com
kubectl exec -n team-d "$WEB_POD" -- curl -I --max-time 5 https://example.com
```

기대 결과:

- `https://api.github.com` 접근은 허용된다.
- `https://example.com` 접근은 차단 또는 timeout된다.
- Hubble에서 허용/차단 결과를 flow로 확인할 수 있다.

### 6. HTTP L7 정책을 검증한다

```bash
WEB_POD=$(kubectl get pod -n team-d -l app.kubernetes.io/name=web -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n team-d "$WEB_POD" -- curl -i --max-time 5 http://api/healthz
kubectl exec -n team-d "$WEB_POD" -- curl -i --max-time 5 http://api/
kubectl exec -n team-d "$WEB_POD" -- curl -X POST -i --max-time 5 http://api/healthz
```

기대 결과:

- `GET /healthz`는 허용된다.
- `/` 또는 `POST /healthz`는 차단된다.
- `hubble observe --namespace team-d --protocol http`에서 HTTP flow와 verdict를 확인할 수 있다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** 공격자가 취약한 웹 Pod를 장악한 뒤 내부 서비스, 외부 FQDN, 의심스러운 HTTP endpoint로 접근한다. 기본 L3/L4 정책만 있거나 flow visibility가 부족하면 어떤 경로로 이동했는지 파악하는 데 시간이 오래 걸린다.
- **영향 범위:** 침해 조사 지연, lateral movement 탐지 지연, 외부 C2 또는 데이터 유출 경로 분석 지연, 정책 오탐/누락 확인 어려움
- **심각도:** **중간** — 기본 차단 정책 자체보다 우선순위는 낮지만, 운영 관찰성과 사고 대응 성숙도를 높이는 핵심 항목이다.

반대로 무리하게 운영 클러스터의 CNI를 전환하면 pod 네트워크 장애, 정책 오탐, DNS 장애, L7 proxy 영향 같은 리스크가 생길 수 있다. 따라서 실습 환경에서 CNI chaining으로 검증하고, 운영 적용은 변경 창과 rollback 계획을 갖춘 상태에서 진행한다.

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습, 플랫폼/네트워크 담당자 리뷰 필요 |
| 예상 소요 시간 | 실습 환경 검토 1시간 + 설치/정책 적용 1시간 + flow 검증 1시간 |
| AWS 추가 비용 | Cilium/Hubble 자체 비용은 없음. Hubble UI/Relay Pod, Cilium agent/operator 리소스 사용량은 노드 비용에 포함된다. |
| 도구 비용 | Cilium, Hubble은 오픈소스 사용 가능. 상용 지원이나 엔터프라이즈 기능은 별도 비용이 발생할 수 있다. |
| 운영 비용 | CNI 변경 검토, 정책 튜닝, 장애 대응 runbook 관리 비용이 발생한다. |

## 참고 자료

- [Cilium AWS CNI chaining](https://docs.cilium.io/en/stable/installation/cni-chaining-aws-cni/)
- [Cilium network policy overview](https://docs.cilium.io/en/stable/security/policy/)
- [Cilium DNS-based policies](https://docs.cilium.io/en/stable/security/dns.html)
- [Cilium and Hubble documentation](https://docs.cilium.io/en/stable/index.html)


## 연계된 보안 가이드라인 항목


추후 업데이트 예정.

## 적용 시 체크리스트

- [ ] Cilium 배포 모델이 Amazon VPC CNI chaining인지 full replacement인지 명확히 문서화되어 있는가?
- [ ] Hubble relay/UI가 활성화되어 있고 `hubble observe`로 Namespace 단위 flow를 조회할 수 있는가?
- [ ] 표준 `NetworkPolicy`로 default deny와 필수 L4 통신만 허용하고 있는가?
- [ ] DNS/FQDN 기반 `CiliumNetworkPolicy`가 실제 외부 egress 제어에 반영되는가?
- [ ] HTTP method/path 기반 L7 정책이 실제 요청에 반영되는가?
- [ ] 허용/차단된 트래픽이 Hubble CLI 또는 UI에서 추적되는가?
- [ ] 운영 적용 전 rollback 절차와 workload restart 영향이 검토되었는가?
