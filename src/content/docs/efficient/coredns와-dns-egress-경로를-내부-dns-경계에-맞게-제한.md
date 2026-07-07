---
title: "CoreDNS와 DNS egress 경로를 내부 DNS 경계에 맞게 제한한다"
description: "Kubernetes 내부의 서비스 디스커버리는 DNS에 크게 의존한다. Pod는 보통 `api.team-a.svc.cluster.local`, `kubernetes.default.svc.cluster.local` 같은 이름을 질의하고, kubelet이 주입한 `/etc"
phase: "Efficient"
domain: "네트워크 보안"
order: 20
sidebar:
  order: 20
---

## 왜 필요한가

Kubernetes 내부의 서비스 디스커버리는 DNS에 크게 의존한다. Pod는 보통 `api.team-a.svc.cluster.local`, `kubernetes.default.svc.cluster.local` 같은 이름을 질의하고, kubelet이 주입한 `/etc/resolv.conf`에 따라 `kube-dns` Service로 질의를 보낸다. EKS에서는 이 DNS Service 뒤에서 CoreDNS가 Kubernetes Service, Headless Service, Pod DNS 레코드를 응답한다.

문제는 Pod가 반드시 CoreDNS만 사용하도록 강제되는 것은 아니라는 점이다. NetworkPolicy나 CNI 정책 집행이 없으면 Pod는 다음처럼 외부 퍼블릭 DNS 서버로 직접 질의할 수 있다.

```bash
nslookup example.com 8.8.8.8
nslookup example.com 1.1.1.1
```

이 경로가 열려 있으면 CoreDNS 로그, Route 53 Resolver 규칙, Private Hosted Zone, 도메인 기반 egress 통제 정책을 우회할 수 있다. 공격자는 DNS를 통해 외부 C2 도메인을 조회하거나, DNS 터널링 방식으로 데이터를 외부로 유출할 수 있다. 따라서 CoreDNS를 안정적으로 관리하는 것과 별개로, Pod의 DNS egress 목적지를 내부 DNS 경계로 제한해야 한다.

이 항목의 목표는 다음과 같다.

- EKS CoreDNS add-on을 관리형 add-on으로 유지한다.
- Pod의 DNS 질의는 `kube-dns`/CoreDNS로만 허용한다.
- Pod가 `8.8.8.8`, `1.1.1.1` 같은 외부 DNS 서버로 직접 질의하지 못하게 한다.
- NetworkPolicy가 실제 데이터플레인에서 집행되는지 확인한다.

## 수행 방법

**사전 조건**

- EKS 클러스터와 VPC CNI add-on을 수정할 수 있는 IAM 권한이 필요하다.
- `kubectl`이 EKS API Server에 인증되어 있어야 한다.
- NetworkPolicy를 실제로 집행할 정책 엔진이 필요하다.
  - Amazon VPC CNI NetworkPolicy 기능
  - Cilium
  - Calico
- 이 문서의 예시는 Amazon VPC CNI NetworkPolicy 기능을 기준으로 한다.

### Step 1: CoreDNS를 EKS managed add-on으로 관리한다

CoreDNS는 클러스터 DNS 질의를 처리하는 핵심 컴포넌트다. EKS에서는 `coredns` add-on을 통해 CoreDNS 버전과 상태를 관리할 수 있다.

Terraform 예시는 다음과 같다.

```hcl
data "aws_eks_addon_version" "coredns" {
  addon_name         = "coredns"
  kubernetes_version = aws_eks_cluster.this.version
  most_recent        = true
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "coredns"
  addon_version               = data.aws_eks_addon_version.coredns.version
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_node_group.this,
  ]
}
```

기존 클러스터에서 `coredns`가 이미 EKS managed add-on이면 Terraform state로 import한다.

```bash
terraform -chdir=environments/infra import \
  'module.eks.aws_eks_addon.coredns' \
  eks-secure-infra-dev:coredns
```

`Cannot import non-existent remote object`가 나오면 EKS managed add-on 객체가 없는 상태다. 이 경우 import하지 않고 `terraform apply`로 생성한다.

```bash
terraform -chdir=environments/infra plan
terraform -chdir=environments/infra apply
```

### Step 2: VPC CNI NetworkPolicy 기능을 활성화한다

NetworkPolicy 리소스를 생성해도 CNI가 정책을 집행하지 않으면 트래픽은 차단되지 않는다. Amazon VPC CNI를 사용하는 경우 `enableNetworkPolicy`를 켜야 한다.

```hcl
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "vpc-cni"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_cluster.this,
  ]
}
```

기존 클러스터에서 `vpc-cni`가 이미 EKS add-on으로 존재하면 import한다.

```bash
terraform -chdir=environments/infra import \
  'module.eks.aws_eks_addon.vpc_cni' \
  eks-secure-infra-dev:vpc-cni
```

적용 후 add-on 상태를 확인한다.

```bash
aws eks describe-addon \
  --cluster-name eks-secure-infra-dev \
  --region ap-northeast-2 \
  --addon-name vpc-cni \
  --query 'addon.{status:status,version:addonVersion,config:configurationValues,issues:health.issues}' \
  --output json
```

기대 결과는 `status`가 `ACTIVE`이고 `configurationValues`에 `enableNetworkPolicy`가 포함되는 것이다.

```json
{
  "status": "ACTIVE",
  "config": "{\"enableNetworkPolicy\":\"true\"}",
  "issues": []
}
```

### Step 3: Namespace 단위 default deny egress를 적용한다

DNS egress를 내부 DNS로 제한하려면 먼저 Namespace의 기본 egress를 차단해야 한다. 기본 차단 정책이 없으면 `allow-dns-egress`를 만들어도 외부 DNS 직접 질의는 계속 허용된다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
```

이 정책은 Namespace 안의 모든 Pod를 선택하고, 허용 규칙이 없으므로 모든 egress를 차단한다.

### Step 4: CoreDNS로 향하는 DNS egress만 허용한다

default deny 상태에서는 내부 서비스 이름 해석도 실패한다. 따라서 `kube-system` Namespace의 CoreDNS Pod로 향하는 TCP/UDP 53번만 허용한다.

```yaml
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

적용 예시는 다음과 같다.

```bash
kubectl apply -k manifests/overlays/team-d
kubectl get networkpolicy -n team-d
```

### Step 5: 정책이 실제 endpoint로 변환되는지 확인한다

Amazon VPC CNI NetworkPolicy가 활성화되면 `aws-node` DaemonSet에 정책 집행용 node agent 컨테이너가 포함된다. 현재 EKS add-on 버전에 따라 컨테이너 이름은 `aws-eks-nodeagent`로 표시될 수 있다.

```bash
kubectl -n kube-system get pod -l k8s-app=aws-node \
  -o jsonpath='{range .items[*]}{.metadata.name}{" => "}{.spec.containers[*].name}{"\n"}{end}'
```

예상 결과:

```text
aws-node-h9dgj => aws-node aws-eks-nodeagent
aws-node-pddfz => aws-node aws-eks-nodeagent
aws-node-wv8hk => aws-node aws-eks-nodeagent
```

정책이 Pod endpoint로 변환되는지도 확인한다.

```bash
kubectl get crd policyendpoints.networking.k8s.aws
kubectl get policyendpoints -A
kubectl get policyendpoints -n team-d
```

`NetworkPolicy`는 있는데 `PolicyEndpoint`가 생성되지 않으면 정책이 실제 데이터플레인에 반영되지 않았을 가능성이 높다.

## 검증 방법

### 1. 취약 상태를 확인한다

정책이 없거나 정책 엔진이 동작하지 않으면 Pod가 외부 DNS 서버로 직접 질의할 수 있다.

```bash
kubectl run dns-public-direct-check \
  --namespace team-d \
  --rm \
  -i \
  --restart=Never \
  --image=busybox:1.36 \
  -- nslookup example.com 8.8.8.8
```

취약한 상태에서는 다음처럼 `8.8.8.8`이 응답한다.

```text
Server:         8.8.8.8
Address:        8.8.8.8:53

Non-authoritative answer:
Name:   example.com
Address: ...
```

이 결과는 Pod가 CoreDNS를 우회해 외부 DNS 서버로 직접 나갈 수 있음을 의미한다.

### 2. 내부 DNS 질의가 성공하는지 확인한다

정책 적용 후에도 Kubernetes Service DNS는 정상 동작해야 한다.

```bash
kubectl run dns-internal-check \
  --namespace team-d \
  --rm \
  -i \
  --restart=Never \
  --image=busybox:1.36 \
  -- nslookup kubernetes.default.svc.cluster.local
```

기대 결과:

```text
Server:         <kube-dns ClusterIP>
Name:           kubernetes.default.svc.cluster.local
Address:        <kubernetes service ClusterIP>
```

### 3. 외부 DNS 직접 질의가 차단되는지 확인한다

짧게 실행되는 `kubectl run --rm ... nslookup` Pod는 NetworkPolicy가 endpoint에 반영되기 전에 질의를 끝낼 수 있다. 더 정확한 검증을 위해 오래 살아있는 테스트 Pod를 만들고, PolicyEndpoint 생성 이후 질의한다.

```bash
kubectl run dns-debug \
  --namespace team-d \
  --restart=Never \
  --image=busybox:1.36 \
  -- sleep 3600

kubectl wait pod dns-debug \
  -n team-d \
  --for=condition=Ready \
  --timeout=60s

kubectl get policyendpoints -n team-d
```

내부 DNS는 성공해야 한다.

```bash
kubectl exec -n team-d dns-debug -- \
  nslookup kubernetes.default.svc.cluster.local
```

외부 DNS 직접 질의는 실패하거나 timeout 되어야 한다.

```bash
kubectl exec -n team-d dns-debug -- \
  nslookup example.com 8.8.8.8

kubectl exec -n team-d dns-debug -- \
  nslookup example.com 1.1.1.1
```

테스트 후 Pod를 삭제한다.

```bash
kubectl delete pod dns-debug -n team-d
```

### 4. CoreDNS와 VPC CNI 상태를 확인한다

```bash
aws eks describe-addon \
  --cluster-name eks-secure-infra-dev \
  --region ap-northeast-2 \
  --addon-name coredns \
  --query 'addon.{status:status,version:addonVersion,issues:health.issues}' \
  --output json

aws eks describe-addon \
  --cluster-name eks-secure-infra-dev \
  --region ap-northeast-2 \
  --addon-name vpc-cni \
  --query 'addon.{status:status,version:addonVersion,config:configurationValues,issues:health.issues}' \
  --output json
```

CoreDNS Pod와 로그도 확인한다.

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system logs deploy/coredns --tail=100
```

VPC CNI node agent 로그는 실제 컨테이너 이름을 확인한 뒤 조회한다.

```bash
kubectl -n kube-system get pod -l k8s-app=aws-node \
  -o jsonpath='{range .items[*]}{.metadata.name}{" => "}{.spec.containers[*].name}{"\n"}{end}'

kubectl -n kube-system logs -l k8s-app=aws-node \
  -c aws-eks-nodeagent \
  --tail=50
```

## Risk 및 미적용 시 영향

- **공격 시나리오:** 침해된 Pod가 CoreDNS를 우회해 `8.8.8.8`, `1.1.1.1` 같은 외부 DNS 서버로 직접 질의한다. 공격자는 DNS 질의를 통해 C2 도메인을 해석하거나 DNS 터널링 방식으로 데이터를 외부로 유출할 수 있다.
- **탐지 회피:** CoreDNS 로그와 메트릭에 질의가 남지 않아 비정상 도메인 조회, 질의 폭증, 데이터 유출 시도를 추적하기 어렵다.
- **정책 우회:** Route 53 Resolver 규칙, Private Hosted Zone, 도메인 기반 egress allowlist가 의도한 경계로 작동하지 않을 수 있다.
- **서비스 안정성 영향:** DNS egress를 잘못 차단하면 Kubernetes Service 이름 해석이 실패하여 애플리케이션 간 통신 장애가 발생할 수 있다.
- **심각도:** **중간~높음** — 외부 DNS 직접 질의는 데이터 유출과 정책 우회의 시작점이 될 수 있다.

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습, 네트워크 보안 담당자 검토 |
| 예상 소요 시간 | Add-on 상태 점검 30분 + 정책 적용 30분 + 검증 1시간 |
| AWS 추가 비용 | CoreDNS/VPC CNI add-on 자체 추가 비용 없음 |
| 운영 비용 | CoreDNS 로그/메트릭 모니터링, 정책 예외 관리 필요 |
| 도구 비용 | Amazon VPC CNI 사용 시 별도 도구 비용 없음. Cilium/Calico 고급 기능 사용 시 운영 복잡도 증가 |

고도화 단계에서는 Route 53 Resolver, Private Hosted Zone, Cilium FQDN policy를 조합해 도메인 기반 egress allowlist를 설계할 수 있다. 단, FQDN 정책은 DNS 질의와 실제 연결 IP의 일관성, TTL, 캐시 동작을 함께 고려해야 한다.

## 참고 자료

- [Amazon EKS CoreDNS add-on](https://docs.aws.amazon.com/eks/latest/userguide/managing-coredns.html)
- [Amazon EKS add-ons](https://docs.aws.amazon.com/eks/latest/userguide/managing-add-ons.html/)
- [Amazon EKS VPC CNI NetworkPolicy 설정](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html)
- [Amazon EKS NetworkPolicy Troubleshooting](https://docs.aws.amazon.com/eks/latest/userguide/network-policies-troubleshooting.html)
- [Kubernetes DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)


## 연계된 보안 가이드라인 항목


추후 업데이트 예정.

## 적용 시 체크리스트

- [ ] CoreDNS가 EKS managed add-on으로 관리되고 `ACTIVE` 상태인가?
- [ ] VPC CNI 또는 대체 CNI가 NetworkPolicy를 실제로 집행하는가?
- [ ] `team-*` Namespace에 `default-deny-egress`가 적용되어 있는가?
- [ ] DNS egress 허용 정책이 `kube-system`의 `k8s-app=kube-dns` Pod, TCP/UDP 53으로만 제한되어 있는가?
- [ ] `PolicyEndpoint` 또는 CNI별 endpoint 정책 객체가 생성되는가?
- [ ] `kubernetes.default.svc.cluster.local` 질의는 성공하는가?
- [ ] `8.8.8.8`, `1.1.1.1` 직접 DNS 질의는 실패하거나 timeout 되는가?
- [ ] CoreDNS 로그/메트릭으로 비정상 질의 증가를 확인할 수 있는가?
