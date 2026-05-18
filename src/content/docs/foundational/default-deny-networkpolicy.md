---
title: "기본 deny NetworkPolicy를 적용한다"
description: "왜 필요한가"
phase: "Foundational"
domain: "네트워크 보안"
difficulty: "미정"
owner: "공통 (전체 실습)"
order: 30
sidebar:
  order: 30
---

## 왜 필요한가

Kubernetes는 기본적으로 같은 클러스터 안의 Pod 간 통신을 넓게 허용한다. Namespace가 나뉘어 있어도 NetworkPolicy가 없으면 취약한 Pod에서 다른 서비스, 내부 API, 데이터 저장소로 접근을 시도할 수 있다. 이 상태에서는 웹 Pod 하나가 침해되었을 때 API, Redis, DB, 관리용 서비스까지 스캔하거나 lateral movement를 수행하기 쉽다.

`default deny` NetworkPolicy는 네트워크 세분화의 출발점이다. 먼저 Ingress와 Egress를 모두 기본 차단하고, DNS, Ingress Controller, 서비스 간 필수 호출처럼 필요한 흐름만 명시적으로 허용한다. 이렇게 하면 침해된 Pod가 임의의 내부 대상으로 확산하는 경로를 줄일 수 있고, “어떤 서비스가 누구와 통신해야 하는지”를 코드로 검토할 수 있다.

EKS에서는 NetworkPolicy 리소스를 생성하는 것만으로 충분하지 않다. Amazon VPC CNI의 NetworkPolicy 기능, Cilium, Calico 같은 정책 엔진이 실제로 정책을 집행해야 한다.

## 수행 방법

**사전 조건**

- `kubectl`을 실행하는 위치가 EKS API Endpoint에 접근 가능해야 한다. Public Endpoint를 끈 경우 VPC 내부 EC2, Bastion, SSM Session Manager, VPN 연결 환경에서 실행한다.
- Amazon VPC CNI NetworkPolicy 기능을 사용하려면 VPC CNI managed add-on 또는 동등한 정책 엔진이 활성화되어 있어야 한다.
- 테스트용 Pod 이미지를 실행할 수 있어야 한다. 예: `nicolaka/netshoot`

### **Step 1: CNI가 NetworkPolicy를 집행하는지 확인한다**

먼저 NetworkPolicy 리소스와 실제 집행 상태를 구분해서 확인한다.

```bash
kubectl get crd policyendpoints.networking.k8s.aws
kubectl -n kube-system get ds aws-node -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"\n"}{end}'
kubectl get policyendpoints -A
```

Amazon VPC CNI NetworkPolicy가 정상적으로 동작한다면 `aws-node` DaemonSet에 `aws-eks-nodeagent` 컨테이너가 있고, 정책이 적용된 Pod에 대해 `PolicyEndpoint` 리소스가 생성되어야 한다.

`NetworkPolicy`는 있는데 `PolicyEndpoint`가 전혀 없다면 정책이 실제 데이터플레인에 반영되지 않은 상태일 가능성이 높다. 이번 실습에서도 `NetworkPolicy` 8개가 생성되었지만 `PolicyEndpoint`가 없어서 `api`, `db`, `web` Service 접근이 모두 성공했다.

### **Step 2: VPC CNI를 managed add-on으로 관리하고 NetworkPolicy를 활성화한다**

기존 클러스터가 self-managed `aws-node`만 사용하고 있으면 AWS CLI의 `describe-addon --addon-name vpc-cni`에서 `No addon: vpc-cni found`가 발생할 수 있다. 이 경우 Terraform으로 VPC CNI를 managed add-on으로 전환하고 NetworkPolicy 기능을 코드로 관리한다.

```hcl
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "vpc-cni"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_eks_cluster.this,
    aws_iam_role_policy_attachment.node_cni_policy,
  ]
}
```

노드 그룹은 VPC CNI add-on 이후 생성되도록 의존성을 둔다.

```hcl
resource "aws_eks_node_group" "this" {
  # ...

  depends_on = [
    aws_eks_addon.vpc_cni,
    aws_iam_role_policy_attachment.node_worker_policy,
    aws_iam_role_policy_attachment.node_cni_policy,
    aws_iam_role_policy_attachment.node_ecr_policy,
  ]
}
```

적용 후 add-on 상태를 확인한다.

```bash
aws eks describe-addon \
  --region ap-northeast-2 \
  --cluster-name eks-secure-infra-dev \
  --addon-name vpc-cni \
  --query 'addon.{version:addonVersion,status:status,configurationValues:configurationValues}' \
  --output json
```

### **Step 3: 먼저 team-d Namespace에만 default deny를 적용한다**

전체 Namespace에 바로 적용하면 기존 실습 워크로드가 동시에 영향을 받을 수 있다. 따라서 `team-d`에 먼저 적용하고 검증한 뒤 모든 워크로드 Namespace로 확장한다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  podSelector: {}
  policyTypes:
    - Egress
```

적용 예시는 다음과 같다.

```bash
kubectl apply -n team-d -f manifests/overlays/team-d/network-policies.yaml
kubectl get networkpolicy -n team-d
```

### **Step 4: DNS Egress를 허용한다**

Egress를 기본 차단하면 DNS도 함께 차단된다. 대부분의 워크로드는 Service 이름을 해석해야 하므로 CoreDNS로 향하는 TCP/UDP 53번을 명시적으로 허용한다.

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

### **Step 5: 필수 서비스 흐름만 허용한다**

이번 실습 워크로드는 `web`, `api`, `db`로 구성되어 있다. 기본 차단 이후 다음 흐름만 허용한다.

| 흐름 | 목적 | 필요한 정책 |
| --- | --- | --- |
| 외부 진입점 → `web` | Ingress/ALB에서 웹 진입 | `allow-public-ingress-to-web` |
| `web` → `api` | 웹에서 API 호출 | `allow-web-to-api`, `allow-api-ingress-from-web` |
| `api` → `db` | API에서 Redis/DB 접근 | `allow-api-to-db`, `allow-db-ingress-from-api` |
| 모든 Pod → CoreDNS | Service 이름 해석 | `allow-dns-egress` |

예시:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-web-to-api
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: web
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: api
      ports:
        - protocol: TCP
          port: 80
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-ingress-from-web
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: web
      ports:
        - protocol: TCP
          port: 80
```

Ingress와 Egress를 각각 명시하는 이유는 default deny가 양방향으로 적용되기 때문이다. 예를 들어 `web`의 Egress만 열고 `api`의 Ingress를 열지 않으면 `web -> api` 통신은 여전히 실패할 수 있다.

## 검증 방법

### **1. 정책 리소스가 생성되었는지 확인한다**

```bash
kubectl get networkpolicy -n team-d
kubectl describe networkpolicy -n team-d
```

기대 결과는 `default-deny-ingress`, `default-deny-egress`, `allow-dns-egress`, `allow-web-to-api`, `allow-api-ingress-from-web`, `allow-api-to-db`, `allow-db-ingress-from-api` 등이 보이는 것이다.

### **2. EKS VPC CNI가 정책을 실제 endpoint로 변환했는지 확인한다**

```bash
kubectl get policyendpoints -A
kubectl -n team-d get policyendpoints
```

기대 결과는 `team-d`의 Pod에 대해 `PolicyEndpoint`가 생성되는 것이다. `No resources found`가 나오면 NetworkPolicy가 실제로 집행되지 않을 수 있다.

### **3. 취약 상태를 확인한다**

정책이 없거나 정책 엔진이 동작하지 않으면 테스트 Deployment Pod에서 내부 서비스 접근이 성공한다.

```bash
kubectl -n team-d create deployment netshoot-after --image=nicolaka/netshoot -- sleep 3600
kubectl -n team-d wait --for=condition=available deployment/netshoot-after --timeout=60s

POD=$(kubectl -n team-d get pod -l app=netshoot-after -o jsonpath='{.items[0].metadata.name}')
kubectl -n team-d exec -it "$POD" -- sh
```

Pod 내부에서 실행한다.

```bash
nslookup api.team-d.svc.cluster.local
nc -vz -w 3 api 80
nc -vz -w 3 db 6379
nc -vz -w 3 web 80
```

미적용 또는 집행 실패 상태에서는 `api`, `db`, `web` 연결이 모두 성공할 수 있다. 이 경우 NetworkPolicy 리소스가 있어도 실제 차단은 되고 있지 않다.

### **4. 적용 후 차단을 확인한다**

정상 적용 후에는 DNS만 성공하고, 임의 테스트 Deployment Pod에서 허용되지 않은 워크로드 Service 접근은 실패해야 한다.

```bash
nslookup api.team-d.svc.cluster.local
nc -vz -w 3 api 80
nc -vz -w 3 db 6379
nc -vz -w 3 web 80
```

기대 결과:

- `nslookup`은 성공한다.
- `api:80`, `db:6379`, `web:80` 접근은 실패 또는 timeout이 발생한다.

`kubernetes.default.svc:443`는 차단 검증 대상으로 사용하지 않는다. Kubernetes API Service는 kube-proxy와 노드 경로가 개입하는 특수 대상이라 NetworkPolicy 구현체에 따라 일반 워크로드 Service와 다르게 보일 수 있다.

### **5. 허용된 서비스 흐름을 확인한다**

`web -> api`, `api -> db`처럼 명시적으로 허용한 흐름은 성공해야 한다. 워크로드 이미지에 `curl`, `nc`가 없으면 임시 디버그 Pod 또는 ephemeral container를 사용한다.

```bash
kubectl -n team-d get pods --show-labels
kubectl -n team-d describe networkpolicy allow-web-to-api
kubectl -n team-d describe networkpolicy allow-api-to-db
```

허용 경로가 실패하면 Ingress 방향 정책과 Egress 방향 정책이 모두 존재하는지, label selector가 실제 Pod label과 일치하는지 확인한다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** 취약한 `web` Pod가 침해된 뒤 공격자가 같은 Namespace의 `api`, `db`, 관리용 Service를 스캔하고 접속을 시도한다.
- **데이터 접근 위험:** API Pod나 DB Pod가 내부 네트워크에서 자유롭게 접근 가능하면 Redis, PostgreSQL, 내부 HTTP API 같은 데이터 계층으로 직접 접근할 수 있다.
- **권한 확대 및 lateral movement:** 하나의 Pod 침해가 Namespace 전체 또는 클러스터 내부 서비스 탐색으로 확장된다.
- **정책 착시 위험:** NetworkPolicy 리소스는 존재하지만 CNI가 집행하지 않으면 보안 통제가 적용된 것처럼 보인다. `PolicyEndpoint` 또는 정책 엔진의 실제 집행 상태까지 검증해야 한다.
- **심각도:** **높음**

## 인적 리소스 및 비용

- AWS 추가 비용: Amazon VPC CNI NetworkPolicy 기능 자체는 별도 과금 없음
- 운영 비용: 정책 설계와 서비스 간 통신 매트릭스 유지 비용 발생
- 도구 비용: VPC CNI 사용 시 추가 도구 비용 없음. Calico/Cilium 도입 시 운영 복잡도 증가 가능

## 참고 자료

- [Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Limit Pod traffic with Kubernetes network policies on Amazon EKS](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)
- [EKS Best Practices — Network Security](https://aws.github.io/aws-eks-best-practices/security/docs/network/)

## Assessment 체크리스트

- [ ] 사용 중인 CNI 또는 정책 엔진이 NetworkPolicy를 실제로 집행하는가?
- [ ] `team-d` Namespace에 `default-deny-ingress`와 `default-deny-egress`가 적용되어 있는가?
- [ ] DNS Egress 허용 정책이 있어 Service 이름 해석이 가능한가?
- [ ] `web -> api`, `api -> db`처럼 필요한 통신만 명시적으로 허용되어 있는가?
- [ ] 임의 테스트 Deployment Pod에서 `api`, `db`, `web` 접근이 차단되는가?
- [ ] `PolicyEndpoint` 또는 정책 엔진 상태를 통해 리소스 선언이 아닌 실제 집행을 검증했는가?
- [ ] `team-d`에서 검증 후 모든 워크로드 Namespace로 확장할 계획이 있는가?

