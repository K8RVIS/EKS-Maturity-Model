# Public API endpoint 접근 CIDR을 신뢰 구간으로 제한한다

> **Phase:** Quick Wins
>
> **보안 영역:** 네트워크 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

#### 왜 필요한가

EKS 클러스터의 Kubernetes API 서버 엔드포인트는 `kubectl`, Terraform, GitOps 컨트롤러, 운영 자동화가 클러스터를 제어할 때 사용하는 관리 평면 진입점이다. 인증과 인가는 IAM, EKS access entry 또는 Kubernetes RBAC로 보호되지만, Public API Endpoint가 인터넷 전체에 열려 있으면 인증 시도 자체가 어디서든 가능해진다.

Private Endpoint 전환이 당장 어렵다면 최소한 Public API Endpoint의 출발지 CIDR을 제한해야 한다. `0.0.0.0/0` 허용은 운영자가 어디서든 접근할 수 있어 편하지만, 공격자 입장에서도 인터넷 어디서든 API 서버를 스캔하고 인증 우회, 취약한 자격 증명, 탈취된 kubeconfig, 잘못된 IAM 권한을 계속 시도할 수 있는 상태가 된다.

따라서 Public API Endpoint를 유지해야 하는 단계에서는 다음 원칙을 적용한다.

- 관리망, VPN, Bastion, 고정 NAT Gateway EIP처럼 신뢰할 수 있는 출발지만 허용한다.
- 임시 운영 IP를 수동으로 계속 추가하는 방식은 피하고, IaC로 변경 이력을 남긴다.
- 가능하면 `endpoint_public_access = true`, `endpoint_private_access = true`의 혼합 단계를 거쳐 최종적으로는 Public Endpoint를 끄는 방향으로 전환한다.

현재 `eks-secure-infra` 실습 환경에서도 이 통제의 적용 지점을 확인할 수 있다. [main.tf](/Users/esc/Desktop/K8RVIS/eks-secure-infra/modules/eks/main.tf:102)의 `aws_eks_cluster.this`는 Public Endpoint와 Private Endpoint를 모두 켜고 있지만, `public_access_cidrs`를 명시하지 않는다.

```hcl
vpc_config {
  subnet_ids              = var.cluster_subnet_ids
  endpoint_private_access = true
  endpoint_public_access  = true
}
```

이 경우 Public Endpoint가 기본 허용 CIDR에 의존할 수 있으므로, 실습 환경에서도 운영자 접속 출발지를 명시적으로 제한하는 구조를 갖추는 것이 좋다.

#### 수행 방법

**사전 조건**

- EKS 클러스터를 수정할 수 있는 IAM 권한이 있어야 한다. 예: `eks:UpdateClusterConfig`, `eks:DescribeCluster`
- 운영자가 실제로 클러스터에 접근하는 출발지 IP를 식별해야 한다.
- VPN, 사내망, Bastion, NAT Gateway, CI/CD runner, GitOps runner 등 클러스터 관리 트래픽의 출발지를 구분해야 한다.
- 변경 후 접근이 차단될 수 있으므로, 적용 전에 대체 접속 경로나 롤백 절차를 준비해야 한다.

**Step 1: 현재 API Endpoint 설정을 확인한다**

먼저 Public Endpoint가 켜져 있는지, 허용 CIDR이 무엇인지 확인한다.

```bash
export CLUSTER_NAME=prod-eks
export AWS_REGION=ap-northeast-2

aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --query 'cluster.resourcesVpcConfig.{endpointPublicAccess:endpointPublicAccess,endpointPrivateAccess:endpointPrivateAccess,publicAccessCidrs:publicAccessCidrs}' \
  --output json
```

미적용 또는 취약한 상태는 다음과 같다.

```json
{
  "endpointPublicAccess": true,
  "endpointPrivateAccess": false,
  "publicAccessCidrs": [
    "0.0.0.0/0"
  ]
}
```

IPv6 dual-stack 클러스터에서는 `::/0`도 함께 고려해야 한다. IPv4 클러스터에는 IPv4 CIDR만 등록할 수 있고, 2024년 10월 이후 생성된 IPv6 클러스터의 dual-stack 엔드포인트는 IPv4와 IPv6 CIDR을 모두 등록할 수 있다.

**Step 2: 허용할 운영 출발지 CIDR을 식별한다**

운영자가 사용하는 현재 공인 IP를 임시로 확인하려면 다음처럼 조회할 수 있다.

```bash
curl -s https://checkip.amazonaws.com
```

다만 개인 회선이나 유동 IP를 그대로 운영 CIDR로 등록하는 것은 권장하지 않는다. 운영 환경에서는 다음과 같은 고정 출발지를 우선 사용한다.

| 출발지 유형 | 권장 여부 | 설명 |
| --- | --- | --- |
| 사내 VPN Egress IP | 권장 | 운영자 접속을 VPN으로 통제하고 감사하기 쉽다. |
| Bastion 또는 관리용 EC2의 EIP | 권장 | 클러스터 접근 경로를 소수의 관리 호스트로 제한할 수 있다. |
| NAT Gateway EIP | 조건부 권장 | 노드나 자동화가 Public Endpoint를 통해 접근해야 하는 구조라면 포함해야 한다. |
| 개인 PC의 현재 공인 IP | 임시 허용 | 장애 대응 등 단기 예외로만 사용하고 만료 절차를 둔다. |
| `0.0.0.0/0` | 금지 | 인터넷 전체에서 API Endpoint 접근 시도가 가능하다. |

**Step 3: AWS CLI로 Public Access CIDR을 제한한다**

Private Endpoint를 함께 켜면 VPC 내부의 노드와 운영 자동화는 Private Endpoint를 사용할 수 있고, 외부 운영자는 제한된 Public CIDR에서만 접근할 수 있다.

```bash
aws eks update-cluster-config \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --resources-vpc-config endpointPublicAccess=true,endpointPrivateAccess=true,publicAccessCidrs="203.0.113.5/32"
```

여러 출발지를 허용해야 한다면 콤마로 구분한다.

```bash
aws eks update-cluster-config \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --resources-vpc-config endpointPublicAccess=true,endpointPrivateAccess=true,publicAccessCidrs="203.0.113.5/32,198.51.100.10/32"
```

운영 중인 노드나 Fargate Pod가 Public Endpoint로 API 서버에 접근하는 구조라면 주의해야 한다. Private Endpoint를 켜지 않은 상태에서 Public CIDR을 좁히면, 노드가 사용하는 NAT Gateway EIP나 egress IP를 허용 목록에 포함하지 않았을 때 클러스터 구성 요소의 API 접근이 끊길 수 있다. 따라서 CIDR 제한과 `endpointPrivateAccess=true`를 함께 적용하는 방식을 기본값으로 둔다.

**Step 4: Terraform으로 변경을 고정한다**

수동 변경은 장애 대응 중 누적되기 쉽고, 시간이 지나면 어떤 CIDR이 왜 열려 있는지 추적하기 어려워진다. `eks-secure-infra`처럼 Terraform으로 EKS를 관리한다면 `public_access_cidrs`를 변수화해서 코드 리뷰와 변경 이력을 남긴다.

예시 변수:

```hcl
variable "cluster_public_access_cidrs" {
  description = "CIDR blocks allowed to access the EKS public API endpoint."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.cluster_public_access_cidrs, "0.0.0.0/0")
    error_message = "Do not allow 0.0.0.0/0 for the EKS public API endpoint."
  }
}
```

EKS 클러스터 설정:

```hcl
resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.cluster_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.cluster_public_access_cidrs
  }
}
```

환경별 입력값:

```hcl
cluster_public_access_cidrs = [
  "203.0.113.5/32",    # VPN egress
  "198.51.100.10/32",  # operations bastion
]
```

최종 목표가 Private Endpoint 전용 운영이라면 아래와 같이 Public Endpoint를 끄는 단계를 별도 변경으로 진행한다.

```hcl
vpc_config {
  subnet_ids              = var.cluster_subnet_ids
  endpoint_private_access = true
  endpoint_public_access  = false
}
```

이 단계에서는 `kubectl`, Terraform, CI/CD, Argo CD 같은 운영 도구가 VPC 내부 또는 연결된 네트워크에서 API 서버에 접근할 수 있어야 한다.

**Step 5: 임시 CIDR 예외 운영 절차를 둔다**

장애 대응 때문에 임시 운영 IP를 열어야 할 수 있다. 이 경우에도 콘솔에서 바로 추가하고 잊어버리는 방식은 피한다.

- 예외 CIDR, 요청자, 사유, 만료 시각을 기록한다.
- 가능하면 Terraform 변수나 별도 allowlist 파일로 관리한다.
- 만료 시간이 지난 CIDR은 정기 점검 또는 자동화로 제거한다.
- 개인 IP 예외가 자주 필요하다면 VPN, Bastion, SSM Session Manager 같은 고정 관리 경로로 전환한다.

#### 검증 방법

먼저 EKS 설정값이 의도한 상태인지 확인한다.

```bash
aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --query 'cluster.resourcesVpcConfig.{endpointPublicAccess:endpointPublicAccess,endpointPrivateAccess:endpointPrivateAccess,publicAccessCidrs:publicAccessCidrs}' \
  --output json
```

기대 결과는 다음과 같다.

```json
{
  "endpointPublicAccess": true,
  "endpointPrivateAccess": true,
  "publicAccessCidrs": [
    "203.0.113.5/32",
    "198.51.100.10/32"
  ]
}
```

허용 CIDR 내부에서는 `kubectl`이 정상 동작해야 한다.

```bash
kubectl get nodes
kubectl auth can-i get pods -A
```

허용되지 않은 외부 IP에서는 API 서버 연결 또는 TLS handshake 단계에서 실패해야 한다. 예를 들어 VPN을 끄거나, 허용 목록에 없는 네트워크에서 다음 명령을 실행한다.

```bash
kubectl get ns --request-timeout=5s
```

기대 결과는 타임아웃 또는 API 서버 연결 실패다. 인증 실패가 아니라 네트워크 연결 실패에 가까운 결과가 나와야 CIDR 제한이 동작한다고 볼 수 있다.

Terraform으로 관리한다면 코드 기준도 함께 검증한다.

```bash
terraform plan
```

기대 결과는 `public_access_cidrs`가 신뢰 CIDR 목록으로 유지되고, `0.0.0.0/0` 또는 불필요한 임시 IP가 새로 추가되지 않는 것이다.

VPN IP가 바뀌는 환경에서는 운영 절차와 실제 CIDR이 일치하는지 정기 점검한다.

```bash
aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${AWS_REGION}" \
  --query 'cluster.resourcesVpcConfig.publicAccessCidrs' \
  --output text
```

#### Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 인터넷에서 EKS API Endpoint를 식별한 뒤, 탈취된 kubeconfig, 유출된 IAM 자격 증명, 취약한 인증 연동, 잘못된 RBAC 매핑을 이용해 API 서버 접근을 반복 시도한다.
- **영향 범위:** 클러스터 리소스 조회, Secret 또는 ConfigMap 접근, 워크로드 변조, 악성 Pod 배포, 노드 및 클러스터 내부로의 추가 침투 가능성
- **운영 리스크:** CIDR 제한을 잘못 적용하면 운영자, CI/CD, 노드, Fargate Pod, GitOps 도구의 API 접근이 차단될 수 있다. 변경 전 허용해야 할 egress IP와 Private Endpoint 경로를 확인해야 한다.
- **심각도:** **높음**. API 서버는 클러스터 관리 평면이므로, 인터넷 전체에 노출된 상태는 인증 실패만으로 끝나지 않고 지속적인 스캐닝과 자격 증명 오남용 시도에 노출된다.

#### 인적 리소스 및 비용

- **담당자 및 예상 소요 시간:** 플랫폼 엔지니어 1명 기준으로 현황 점검 30분, CIDR 식별 및 적용 30분~1시간, 외부망 검증 30분 내외
- **AWS 비용 발생 여부 및 예상 규모:** CIDR 제한 자체에는 추가 비용이 없다.
- **간접 비용:** Private Endpoint 전용 운영으로 전환할 경우 VPN, Direct Connect, Transit Gateway, Bastion, SSM Session Manager, CI/CD runner 네트워크 구성 비용이 별도로 발생할 수 있다.
- **오픈소스 vs 상용 도구 선택 시 비용 차이:** 필수 도구 비용은 없다. 정책 검증 자동화가 필요하면 Checkov, tfsec/Trivy, OPA 같은 도구로 IaC에서 `0.0.0.0/0`을 차단할 수 있다.

#### 참고 자료

- [Amazon EKS - Cluster API server endpoint](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html)
- [Amazon EKS - Configure network access to cluster API server endpoint](https://docs.aws.amazon.com/eks/latest/userguide/config-cluster-endpoint.html)
- [CIS Amazon EKS Benchmark v1.8.0](../CIS_Amazon_Elastic_Kubernetes_Service_(EKS)_v.1.8.0_PDF.md)

#### 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Amazon EKS Benchmark v1.8.0**
  `5.4.1 Restrict Access to the Control Plane Endpoint`
  Private Endpoint를 활성화하고, Public Endpoint를 유지해야 한다면 `publicAccessCidrs`가 `0.0.0.0/0`이 아닌 신뢰 CIDR로 제한되어 있는지 확인하도록 권고한다.
- **CIS Amazon EKS Benchmark v1.8.0**
  `5.4.2 Ensure clusters are created with Private Endpoint Enabled and Public Access Disabled`
  궁극적으로는 Kubernetes API 서버 Public Endpoint를 비활성화하고, VPC 내부 또는 연결된 네트워크에서만 API 서버에 접근하도록 구성하는 방향을 제시한다.
- **CIS Controls v8**
  `4.4 Implement and Manage a Firewall on Servers`
  관리 평면에 접근 가능한 네트워크 경계를 제한하고 허용 목록 기반으로 통제한다는 관점에서 연결된다.

#### Assessment 체크리스트

- [ ] EKS Public API Endpoint의 `publicAccessCidrs`에 `0.0.0.0/0` 또는 불필요한 광범위 CIDR이 없는가?
- [ ] 운영자, VPN, Bastion, NAT Gateway, CI/CD runner 등 실제 관리 트래픽 출발지가 식별되어 있는가?
- [ ] Public Endpoint를 유지하는 동안 `endpointPrivateAccess=true`가 함께 적용되어 있는가?
- [ ] 허용 CIDR 내부에서는 `kubectl` 접근이 성공하고, 허용되지 않은 외부 IP에서는 실패하는가?
- [ ] `public_access_cidrs`가 Terraform 등 IaC로 관리되고 변경 이력이 남는가?
- [ ] 임시 운영 IP 예외에 요청자, 사유, 만료 시각, 제거 절차가 있는가?
- [ ] 최종적으로 Public Endpoint를 끄기 위한 Private Endpoint 접속 경로가 준비되어 있는가?
