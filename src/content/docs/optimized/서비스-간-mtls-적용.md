---
title: "서비스 간 mTLS를 적용한다"
description: "Ingress 또는 Load Balancer에서 TLS를 강제해도 클러스터 내부 Pod 간 통신은 여전히 평문일 수 있다. 공격자가 취약한 Pod, 노드, 디버그 컨테이너, 과도한 권한의 DaemonSet을 확보하면 같은 클러스터 내부의 east-west 트래픽을 관찰"
phase: "Optimized"
domain: "네트워크 보안"
difficulty: "★★★"
owner: "공통 (전체 실습)"
order: 20
sidebar:
  order: 20
---

## 왜 필요한가

Ingress 또는 Load Balancer에서 TLS를 강제해도 클러스터 내부 Pod 간 통신은 여전히 평문일 수 있다. 공격자가 취약한 Pod, 노드, 디버그 컨테이너, 과도한 권한의 DaemonSet을 확보하면 같은 클러스터 내부의 east-west 트래픽을 관찰하거나 내부 서비스처럼 위장해 호출할 수 있다.

mTLS는 단순 암호화가 아니라 양쪽 workload가 서로의 신원을 검증하는 통제다. 따라서 네트워크 위치나 IP 대역을 신뢰하는 방식보다 Kubernetes ServiceAccount, SPIFFE ID, mesh identity 같은 workload identity 기반 접근 제어를 만들 수 있다. 계정, 결제, 주문, 내부 API Gateway, 관리자 API처럼 민감도가 높은 서비스는 Security Group이나 NetworkPolicy만으로는 충분하지 않으며, 서비스 간 인증과 암호화를 함께 강제해야 한다.

이 항목에서는 EKS에서 서비스 간 mTLS를 도입하기 위한 기준 문서를 만들었다. 문서의 목표는 다음과 같다.

- 내부 서비스 간 평문 호출 가능 여부를 명령어로 확인한다.
- Istio 기반 mTLS 적용 절차와 검증 절차를 표준화한다.
- Cilium mTLS와 Istio mTLS를 비교하고, 현재 운영 적용에 더 적합한 선택지를 정한다.
- 비메시 workload와 혼재되는 전환 기간의 예외 정책을 명확히 관리한다.

## 수행 방법

**사전 조건**

- EKS 클러스터와 `kubectl` 접근 권한이 필요하다.
- `istioctl`, `jq`, `curl` 또는 테스트용 `netshoot` 이미지 사용 권한이 필요하다.
- 서비스별 Namespace, ServiceAccount, 호출 관계가 정리되어 있어야 한다.
- 전면 강제 전에 민감 Namespace 하나를 선정해 관측 모드로 시작한다.

### **Step 1: 적용 방식을 결정한다**

EKS에서 Pod 간 mTLS는 현실적으로 Service Mesh를 통해 적용하는 경우가 가장 많다. 현재 기준으로는 **Istio를 기본 권고안**으로 둔다.

| 항목 | Istio mTLS | Cilium mTLS |
| --- | --- | --- |
| 현재 성숙도 | 운영 적용 사례와 정책 모델이 성숙하다. | Cilium 문서상 Mutual Authentication은 Beta이며 일부 보안 모델 작업이 남아 있다. |
| 암호화 방식 | Envoy sidecar 또는 ambient ztunnel 경유 mTLS. | Cilium mutual authentication은 인증 핸드셰이크를 정책에 추가한다. 일반 요구사항을 충족하려면 WireGuard/IPsec 같은 암호화 기능을 함께 고려해야 한다. |
| 정책 모델 | `PeerAuthentication`, `DestinationRule`, `AuthorizationPolicy`로 mTLS와 L7 인가를 함께 표현한다. | `CiliumNetworkPolicy`에 `authentication.mode: "required"`를 추가한다. Cilium identity, SPIFFE/SPIRE와 결합된다. |
| 관측성 | Kiali, Prometheus, Grafana, Envoy metrics, `istioctl` 분석을 활용한다. | Hubble flow, Cilium metrics, agent log를 활용한다. |
| 도입 부담 | sidecar 모드는 Pod 리소스와 injection 관리가 필요하다. ambient 모드는 sidecar 부담을 줄일 수 있지만 운영 표준을 별도로 잡아야 한다. | 이미 Cilium CNI/Hubble을 쓰는 클러스터에서는 네트워크 정책과 관측성을 한 도구로 묶을 수 있다. 단, mTLS 기능 자체는 아직 신중한 파일럿이 필요하다. |
| 멀티클러스터/외부 연동 | Istio 멀티클러스터, 외부 CA, ACM Private CA 연동 선택지가 넓다. | 현재 Cilium mutual authentication은 Cilium-managed cluster 내부 중심이며 Cluster Mesh와 함께 단일 trust domain을 만드는 방식은 제한이 있다. |
| 권고 | 민감 서비스의 운영 mTLS 기본안. | 이미 Cilium을 표준 CNI/정책 엔진으로 쓰고 있고, Beta 제약을 수용할 수 있는 실습/파일럿에 적합하다. |

**결론:** 지금 이 성숙도 모델의 기준 통제에는 **Istio 기반 mTLS를 우선 적용**한다. 이유는 mTLS 강제, 점진 도입, plaintext 차단 검증, L7 `AuthorizationPolicy`까지 한 번에 운영 표준으로 만들기 쉽기 때문이다. Cilium mTLS는 Cilium 기반 네트워크 정책과 Hubble 관측성을 이미 채택한 클러스터에서 별도 파일럿 항목으로 검증한다.

### **Step 2: 대상 Namespace를 관측 모드로 메시 편입한다**

먼저 민감 서비스 Namespace를 하나 정한다. 예시는 `payments`다.

```bash
kubectl create namespace payments
kubectl label namespace payments istio-injection=enabled --overwrite
kubectl get namespace payments --show-labels
```

기존 workload는 sidecar가 자동 주입되도록 재시작한다.

```bash
kubectl rollout restart deployment -n payments
kubectl rollout status deployment -n payments --timeout=180s
```

전환 초기에 전체 호출을 바로 차단하지 않으려면 `PERMISSIVE` 모드로 시작해 plain text 호출과 mTLS 호출을 함께 관측한다.

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: PERMISSIVE
```

```bash
kubectl apply -f manifests/security/istio/payments-peerauthentication-permissive.yaml
```

### **Step 3: Namespace 단위 mTLS STRICT를 적용한다**

관측 기간 동안 비메시 workload, 헬스체크, 배치 작업, 외부 연동 호출을 정리한 뒤 `STRICT`로 전환한다.

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: payments
spec:
  mtls:
    mode: STRICT
```

```bash
kubectl apply -f manifests/security/istio/payments-peerauthentication-strict.yaml
kubectl get peerauthentication -n payments default -o yaml
```

`STRICT` 모드에서는 sidecar 또는 ambient mesh에 편입되지 않은 plain client가 해당 Namespace의 workload로 직접 호출할 수 없어야 한다.

### **Step 4: 인가 정책을 함께 적용한다**

mTLS는 “호출자가 누구인지”를 검증하지만, 그 호출자가 “무엇을 해도 되는지”까지 자동으로 정하지는 않는다. 민감 서비스에는 default-deny `AuthorizationPolicy`를 먼저 두고 필요한 호출만 허용한다.

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: default-deny
  namespace: payments
spec: {}
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-checkout-to-payment-api
  namespace: payments
spec:
  selector:
    matchLabels:
      app: payment-api
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - cluster.local/ns/checkout/sa/checkout-api
      to:
        - operation:
            methods: ["GET", "POST"]
            paths: ["/v1/payments/*"]
```

```bash
kubectl apply -f manifests/security/istio/payments-authorizationpolicy.yaml
```

### **Step 5: 혼재 구간 예외를 관리한다**

비메시 workload와의 혼재 구간에서는 예외를 문서화하고 만료일을 둔다.

- `PERMISSIVE`는 전환 기간에만 사용한다.
- 특정 workload 또는 port만 예외 처리해야 하면 `PeerAuthentication`의 workload selector 또는 port-level 설정을 사용한다.
- 예외가 필요한 서비스는 소유자, 사유, 만료일, 제거 조건을 이슈나 변경관리 문서에 남긴다.
- 예외가 남아 있는 동안 NetworkPolicy, Security Group for Pods, Istio `AuthorizationPolicy`를 함께 적용해 우회 범위를 줄인다.

## 검증 방법

### **1. 취약점이 열려있는지 확인한다**

다음 명령어 세트는 “서비스 간 mTLS가 없거나 강제되지 않아 내부 평문 호출이 가능한 상태”인지 확인한다.

**메시 또는 mTLS 정책 부재 확인**

```bash
kubectl get ns istio-system
kubectl get crd peerauthentications.security.istio.io authorizationpolicies.security.istio.io
kubectl get peerauthentication -A
kubectl get authorizationpolicy -A
```

취약한 상태의 예시는 다음과 같다.

- `istio-system` Namespace가 없거나 Istio CRD가 없다.
- 민감 Namespace에 `PeerAuthentication`이 없다.
- `PeerAuthentication`이 `PERMISSIVE`로 장기간 남아 있다.
- `AuthorizationPolicy`가 없어 유효한 mesh identity를 가진 workload가 민감 서비스에 넓게 접근할 수 있다.

**sidecar 주입 또는 ambient 편입 상태 확인**

```bash
kubectl get namespace payments checkout --show-labels
kubectl get pod -n payments -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\n"}{end}'
kubectl get pod -n checkout -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\n"}{end}'
```

sidecar 모드라면 대상 Pod의 container 목록에 `istio-proxy`가 있어야 한다. ambient 모드를 쓰는 경우 Namespace 또는 Pod가 ambient mesh에 편입되어 있는지 별도 라벨 기준으로 확인한다.

**plain client에서 민감 서비스 직접 호출 테스트**

```bash
kubectl create namespace mtls-check
kubectl run plain-client -n mtls-check --image=curlimages/curl:8.8.0 --restart=Never -- sleep 3600
kubectl wait pod/plain-client -n mtls-check --for=condition=Ready --timeout=90s

kubectl exec -n mtls-check plain-client -- \
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 \
  http://payment-api.payments.svc.cluster.local:8080/healthz
```

취약한 상태에서는 메시 밖의 `plain-client`가 `200`, `401`, `403` 등 애플리케이션 응답을 받을 수 있다. `401`이나 `403`도 네트워크 레벨의 mTLS 강제가 아니라 애플리케이션 레벨 인증/인가까지 도달했다는 의미이므로, 서비스 간 평문 경로가 열려 있을 수 있다.

**Istio 관점의 mTLS 상태 확인**

```bash
istioctl proxy-status
istioctl authn tls-check "$(kubectl get pod -n checkout -l app=checkout-api -o jsonpath='{.items[0].metadata.name}')" \
  -n checkout payment-api.payments.svc.cluster.local
istioctl analyze -A
```

취약하거나 불완전한 상태에서는 대상 서비스가 `DISABLE`, `PERMISSIVE`, `CONFLICT`, `UNKNOWN`처럼 표시되거나, proxy sync 문제가 나타날 수 있다.

### **2. 적용 후 상태를 검증한다**

다음 명령어 세트는 mTLS 강제와 인가 정책이 기대대로 동작하는지 확인한다.

**Istio control plane과 proxy 상태 확인**

```bash
istioctl version
istioctl proxy-status
kubectl get pod -n istio-system
kubectl get peerauthentication -n payments default -o jsonpath='{.spec.mtls.mode}{"\n"}'
kubectl get authorizationpolicy -n payments
```

기대 결과:

- `istioctl proxy-status`에서 대상 proxy가 `SYNCED` 상태다.
- `payments/default` `PeerAuthentication`이 `STRICT`다.
- `payments` Namespace에 default-deny와 필요한 allow 정책이 있다.

**메시 내부 허용 클라이언트 호출 성공 확인**

```bash
CHECKOUT_POD="$(kubectl get pod -n checkout -l app=checkout-api -o jsonpath='{.items[0].metadata.name}')"

kubectl exec -n checkout "$CHECKOUT_POD" -c checkout-api -- \
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 \
  http://payment-api.payments.svc.cluster.local:8080/v1/payments/health
```

기대 결과는 `200` 또는 서비스가 정의한 정상 응답 코드다.

**메시 외부 plain client 호출 실패 확인**

```bash
kubectl exec -n mtls-check plain-client -- \
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 \
  http://payment-api.payments.svc.cluster.local:8080/v1/payments/health
```

기대 결과는 연결 실패, timeout, reset, `000` 등이다. plain client가 애플리케이션 응답 코드를 받으면 `STRICT` 적용 범위, sidecar/ambient 편입, Service selector, 예외 정책을 다시 확인해야 한다.

**mTLS 사용 여부 확인**

```bash
istioctl authn tls-check "$CHECKOUT_POD" \
  -n checkout payment-api.payments.svc.cluster.local

kubectl exec -n checkout "$CHECKOUT_POD" -c istio-proxy -- \
  pilot-agent request GET stats/prometheus | grep -E 'ssl|tls|rbac|authorization'
```

Kiali 또는 Prometheus/Grafana를 사용하는 경우 다음 지표와 화면도 함께 확인한다.

```bash
kubectl -n istio-system port-forward svc/kiali 20001:20001
kubectl -n istio-system port-forward svc/prometheus 9090:9090
```

기대 결과:

- Kiali graph에서 `payments`로 들어오는 edge가 mTLS로 표시된다.
- Prometheus에서 Istio request metric이 source/destination workload, response code, security policy 차원으로 수집된다.
- `AuthorizationPolicy`에 의해 허용되지 않은 호출은 실패하고, 허용된 principal의 호출만 성공한다.

**인가 정책 우회 여부 확인**

```bash
kubectl run rogue-client -n checkout --image=curlimages/curl:8.8.0 --restart=Never -- sleep 3600
kubectl wait pod/rogue-client -n checkout --for=condition=Ready --timeout=90s

kubectl exec -n checkout rogue-client -- \
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 \
  http://payment-api.payments.svc.cluster.local:8080/v1/payments/health
```

기대 결과는 `403` 또는 요청 차단이다. 같은 Namespace에 있더라도 허용된 ServiceAccount principal이 아니면 민감 서비스에 접근할 수 없어야 한다.

### **3. Cilium mTLS 파일럿을 검증할 때의 추가 명령어**

Cilium 기반 파일럿을 수행하는 경우에는 먼저 Cilium mutual authentication이 활성화되어 있는지 확인한다.

```bash
cilium status
kubectl get crd ciliumnetworkpolicies.cilium.io ciliumendpoints.cilium.io
kubectl get all -n cilium-spire
kubectl exec -n cilium-spire spire-server-0 -c spire-server -- /opt/spire/bin/spire-server healthcheck
kubectl get ciliumnetworkpolicy -A -o yaml | grep -n 'authentication:\|mode: required'
```

정책 예시는 다음과 같다.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: require-mutual-auth-to-payment-api
  namespace: payments
spec:
  endpointSelector:
    matchLabels:
      app: payment-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: checkout
            app: checkout-api
      authentication:
        mode: "required"
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

적용 후에는 Hubble과 agent log에서 인증 이벤트를 확인한다.

```bash
kubectl apply -f manifests/security/cilium/require-mutual-auth-to-payment-api.yaml
hubble observe --namespace payments --to-pod "$(kubectl get pod -n payments -l app=payment-api -o jsonpath='{.items[0].metadata.name}')" --follow
kubectl -n kube-system logs -l k8s-app=cilium -c cilium-agent --since=10m | \
  grep -E 'Policy is requiring authentication|Validated certificate|Successfully authenticated'
```

Cilium mTLS는 현재 Beta 제약을 전제로 검증한다. 운영 강제 통제의 1차 표준은 Istio로 두고, Cilium은 CNI/NetworkPolicy/Hubble 표준화가 이미 진행된 클러스터에서 별도 실험으로 다룬다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** 공격자가 취약한 내부 Pod를 장악한 뒤 결제 API, 계정 API, 관리자 API를 직접 호출한다. mTLS가 없으면 호출자가 정상 workload인지, 침해된 임의 Pod인지 네트워크 계층에서 구분하기 어렵다.
- **트래픽 도청:** 노드 또는 네트워크 경로를 장악한 공격자가 내부 HTTP 요청, 세션 토큰, 내부 API 응답을 평문으로 관찰할 수 있다.
- **서비스 사칭:** 내부 DNS 이름과 네트워크 경로만으로 신뢰하는 구조에서는 공격자가 정상 서비스처럼 위장하거나 중간자 위치에서 응답을 변조할 수 있다.
- **인가 우회:** NetworkPolicy가 열려 있거나 같은 Namespace 내 통신을 넓게 허용하는 경우, 애플리케이션 인증 전 단계에서 민감 API까지 요청이 도달할 수 있다.
- **영향 범위:** 민감 데이터 유출, 결제/계정 기능 오남용, 내부 API 남용, 사고 원인 분석 지연.
- **심각도:** **높음**

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 플랫폼/보안 담당자, 서비스 오너 |
| 예상 소요 시간 | 관측 대상 선정 0.5일, Istio 설치/기본 정책 0.5~1일, 서비스별 예외 정리와 검증 1~3일 |
| AWS 추가 비용 | Istio 자체는 오픈소스이나 proxy/telemetry 리소스만큼 노드 비용이 증가할 수 있다. ACM Private CA를 루트 CA로 연동하면 Private CA 비용이 별도 발생한다. |
| 도구 비용 | Istio, Cilium, Linkerd는 오픈소스 사용 가능. 운영 대시보드, 장기 로그/메트릭 저장소 비용은 별도 산정한다. |
| 운영 부담 | 인증서/CA 운영, proxy 리소스, 정책 예외 관리, 장애 시 mesh 우회 절차를 운영 표준에 포함해야 한다. |

## Assessment 체크리스트

- [ ] 민감 Namespace에 mTLS `STRICT` 정책이 적용되어 있는가?
- [ ] 비메시 plain client가 민감 서비스로 직접 호출할 수 없는가?
- [ ] 허용된 mesh client만 정상 호출에 성공하는가?
- [ ] `AuthorizationPolicy` default-deny와 필요한 allow 정책이 함께 적용되어 있는가?
- [ ] `PERMISSIVE`, port-level disable, workload-level 예외에 소유자와 만료일이 있는가?
- [ ] telemetry에서 민감 서비스 호출의 mTLS 적용 상태를 확인할 수 있는가?
- [ ] Cilium mTLS를 검토하는 경우 Beta 제약과 SPIRE 운영 요건을 명시했는가?

## 참고 자료

- [AWS EKS Best Practices - Network Security](https://docs.aws.amazon.com/eks/latest/best-practices/network-security.html)
- [Istio PeerAuthentication](https://istio.io/latest/docs/reference/config/security/peer_authentication/)
- [Istio Authentication Policy](https://istio.io/latest/docs/tasks/security/authentication/authn-policy/)
- [Istio Security Best Practices](https://istio.io/latest/docs/ops/best-practices/security/)
- [Cilium Mutual Authentication](https://docs.cilium.io/en/latest/network/servicemesh/mutual-authentication/mutual-authentication/)
- [Cilium Mutual Authentication Example](https://docs.cilium.io/en/latest/network/servicemesh/mutual-authentication/mutual-authentication-example/)
- [Automatic mTLS with Linkerd](https://linkerd.io/2/features/automatic-mtls/)
- [Linkerd Authorization Policy](https://linkerd.io/2/features/server-policy/)

