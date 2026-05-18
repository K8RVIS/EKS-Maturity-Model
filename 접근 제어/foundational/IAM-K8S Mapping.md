# EKS 클러스터에 접속할 IAM 신분을 EKS Access Entries 방식으로 관리한다

> **Phase:** Foundational
>
> **보안 영역:** 접근 제어
>
> **대상:** 공통 (전체 실습)
>
> **난이도:** 기본

---

#### 개요

EKS 클러스터에 접속하는 IAM 사용자 또는 IAM 역할은 Kubernetes API 서버에서 인증된 주체로 매핑되어야 한다. 기존에는 이 매핑을 `aws-auth` ConfigMap에 직접 작성하는 방식이 일반적이었다.

하지만 `aws-auth` ConfigMap 방식은 텍스트 기반의 수동 편집 방식이므로 오타, 들여쓰기 오류, 잘못된 ARN 입력 같은 실수에 취약하다. 특히 관리자 권한 매핑을 잘못 수정하면 클러스터 전체에 접근하지 못하는 상황이 발생할 수 있다.

EKS Access Entries는 이러한 단점을 줄이기 위해 제공되는 AWS 관리형 클러스터 접근 관리 방식이다. IAM 신분과 EKS 클러스터 접근 권한을 AWS API로 관리하므로 변경 이력이 명확해지고, AWS 콘솔과 CLI에서 누가 어떤 권한을 가지고 있는지 확인하기 쉽다.

이번 항목의 목표는 EKS 클러스터 인증 모드를 `API_AND_CONFIG_MAP`로 변경하고, 특정 IAM 사용자 또는 IAM 역할에 대해 Access Entry를 생성한 뒤, 적절한 AWS 관리형 Access Policy를 연결하는 것이다.

- **보안 강화:** 클러스터 접근 권한을 AWS 관리형 API로 관리하여 수동 편집 실수를 줄인다.
- **가시성 확보:** AWS 콘솔과 CLI에서 IAM 주체별 클러스터 접근 권한을 확인할 수 있다.
- **운영 안정성:** `aws-auth` ConfigMap 단독 의존도를 낮추고, 단계적으로 Access Entries 기반 관리로 전환한다.

### Background

기존 `aws-auth` ConfigMap 방식은 Kubernetes 리소스 안에 IAM ARN과 Kubernetes username/group 매핑을 직접 작성한다.

예를 들어 IAM 역할을 Kubernetes 그룹에 매핑하려면 ConfigMap의 `mapRoles` 항목을 수정해야 한다. 이 과정에서 YAML 형식이 깨지거나 관리자 역할이 삭제되면, 클러스터 접근 권한을 복구하기 어려운 상황이 발생할 수 있다.

EKS Access Entries는 IAM 주체를 EKS 클러스터 접근 엔트리로 등록하고, AWS 관리형 Access Policy를 연결하는 방식으로 동작한다. 권한은 AWS API를 통해 생성, 조회, 수정, 삭제할 수 있으며, AWS 콘솔에서도 접근 주체와 연결된 정책을 확인할 수 있다.

EKS Access Entries를 사용하면 다음과 같은 장점이 있다.

- `aws-auth` ConfigMap 수동 편집에 따른 장애 가능성을 줄인다.
- IAM 사용자 또는 IAM 역할 단위로 접근 권한을 명확히 관리할 수 있다.
- AWS CloudTrail을 통해 접근 권한 변경 이벤트를 추적할 수 있다.
- AWS 관리형 정책을 통해 일반적인 EKS 접근 권한을 일관되게 부여할 수 있다.

### Scope

이번 이슈에 포함할 작업:

- 클러스터 인증 모드를 `API_AND_CONFIG_MAP`로 변경
- 특정 IAM 사용자 또는 IAM 역할에 대해 Access Entry 생성
- 권한을 줄 대상의 ARN 확인
- 해당 Access Entry에 적절한 AWS 관리형 Access Policy 연결
- Access Entry와 연결 정책 정상 적용 여부 검증

## 수행 방법

아래 절차는 현재 저장소의 Terraform 반영 방식과 AWS CLI 수동 적용 예시를 함께 설명한다. 운영 반영은 `eks-secure-infra/environments/infra/main.tf`의 `access_entries`을 기준으로 하고, CLI 명령은 동일한 작업을 수동으로 수행하거나 적용 결과를 검증할 때 사용한다.

### 사전 조건

- EKS 클러스터를 수정할 수 있는 AWS IAM 권한이 필요하다.
- `aws` CLI와 `kubectl`이 로컬 환경에 설치되어 있어야 한다.
- 실습 대상 클러스터의 이름, 리전, 권한을 부여할 IAM 사용자 또는 IAM 역할 ARN을 알고 있어야 한다.
- 예시 값은 실제 환경에 맞게 `[cluster명]`, `[region명]`, `[iam-principal-arn]`, `[namespace명]` 형식의 값을 교체하여 사용한다.

### Step 1: 현재 클러스터 인증 모드를 확인한다

먼저 EKS 클러스터의 현재 접근 설정을 확인한다.

```bash
aws eks describe-cluster \
  --name [cluster명] \
  --region [region명] \
  --query "cluster.accessConfig"
```

기대 결과는 다음과 유사하다.

```json
{
  "authenticationMode": "CONFIG_MAP"
}
```

`authenticationMode`가 `CONFIG_MAP`이면 기존 `aws-auth` ConfigMap 방식만 사용 중인 상태이다. Access Entries를 함께 사용하려면 인증 모드를 `API_AND_CONFIG_MAP`로 변경한다.

### Step 2: 클러스터 인증 모드를 API_AND_CONFIG_MAP로 변경한다

기존 `aws-auth` ConfigMap 매핑을 즉시 제거하지 않고 Access Entries를 병행하려면 `API_AND_CONFIG_MAP` 모드를 사용한다.

현재 `eks-secure-infra` 저장소에서는 `eks-secure-infra/environments/infra/main.tf`의 EKS 모듈 호출부에서 인증 모드를 선언한다.

```hcl
module "eks" {
  source = "../../modules/eks"

  # 생략

  authentication_mode = "API_AND_CONFIG_MAP"
}
```

CLI로 수동 변경하는 경우에는 다음 명령을 사용한다.

```bash
aws eks update-cluster-config \
  --name [cluster명] \
  --region [region명] \
  --access-config authenticationMode=API_AND_CONFIG_MAP
```

업데이트가 완료될 때까지 상태를 확인한다.

```bash
aws eks describe-cluster \
  --name [cluster명] \
  --region [region명] \
  --query "cluster.status"
```

상태가 `ACTIVE`가 되면 변경이 완료된 것이다.

변경 후 인증 모드를 다시 확인한다.

```bash
aws eks describe-cluster \
  --name [cluster명] \
  --region [region명] \
  --query "cluster.accessConfig.authenticationMode"
```

기대 결과는 다음과 같다.

```text
"API_AND_CONFIG_MAP"
```

## Step 3: 권한을 부여할 IAM Principal ARN을 확인한다

Access Entry는 IAM 사용자 또는 IAM 역할 ARN을 기준으로 생성한다. 권한을 줄 대상의 ARN을 정확히 확인해야 한다.

현재 저장소에서는 `eks-secure-infra/environments/infra/variables.tf`의 `user_iam_arn` 변수로 권한을 부여할 IAM Principal ARN을 주입한다.

```hcl
variable "user_iam_arn" {
  description = "EKS 관리자 권한을 부여할 IAM ARN"
  type        = string
}
```

이 값은 `environments/infra/main.tf`의 `access_entries`에서 `principal_arn = var.user_iam_arn`으로 사용된다.

현재 AWS CLI가 사용하는 IAM 신분을 확인하려면 다음 명령을 사용한다.

```bash
aws sts get-caller-identity
```

특정 IAM 역할을 사용할 경우 ARN 형식은 다음과 유사하다.

```text
arn:aws:iam::[account-id]:role/[iam-role명]
```

운영 환경에서는 개별 IAM 사용자보다 IAM 역할을 기준으로 권한을 부여하는 방식을 우선 검토한다. 역할 기반 접근은 인력 변경, 임시 권한 부여, 감사 추적 측면에서 관리가 쉽다.

## Step 4: Access Entry를 생성하고 AWS 관리형 Access Policy를 연결한다

확인한 IAM Principal ARN을 사용해 Access Entry를 생성한다.

현재 저장소에서는 `environments/infra/main.tf`의 `access_entries`에 IAM Principal과 연결할 Access Policy를 함께 선언한다.

```hcl
access_entries = {
  teamc_user = {
    principal_arn = var.user_iam_arn
    policy_associations = {
      admin = {
        policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
        access_scope = {
          type = "cluster"
        }
      }
    }
  }
}
```

이 설정은 `var.user_iam_arn`으로 전달된 IAM 사용자 또는 IAM 역할 ARN에 대해 Access Entry를 생성하고, 클러스터 전체 범위의 `AmazonEKSClusterAdminPolicy`를 연결한다.

모듈 내부에서는 `eks-secure-infra/modules/eks/main.tf`의 `aws_eks_access_entry` 리소스가 Access Entry를 생성한다.

```hcl
resource "aws_eks_access_entry" "this" {
  for_each = var.access_entries

  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value.principal_arn
  type          = "STANDARD"
}
```

그리고 `aws_eks_access_policy_association` 리소스가 각 Access Entry에 AWS 관리형 Access Policy를 연결한다.

```hcl
resource "aws_eks_access_policy_association" "this" {
  cluster_name  = aws_eks_cluster.this.name
  policy_arn    = each.value.policy_arn
  principal_arn = each.value.principal

  access_scope {
    type       = each.value.scope.type
    namespaces = lookup(each.value.scope, "namespaces", null)
  }
}
```

CLI로 수동 생성하는 경우에는 다음 명령을 사용한다.

```bash
aws eks create-access-entry \
  --cluster-name [cluster명] \
  --region [region명] \
  --principal-arn [iam-principal-arn]
```

생성된 Access Entry를 확인한다.

```bash
aws eks describe-access-entry \
  --cluster-name [cluster명] \
  --region [region명] \
  --principal-arn [iam-principal-arn]
```

Access Entry 자체는 IAM 주체를 클러스터 접근 대상으로 등록하는 역할을 한다.

EKS Access Entries는 AWS 관리형 Access Policy를 연결하여 Kubernetes 권한을 부여할 수 있다. 대표적인 정책은 다음과 같다.

| Access Policy                 | 용도                                     |
| ----------------------------- | ---------------------------------------- |
| `AmazonEKSClusterAdminPolicy` | 클러스터 전체 관리자 권한                |
| `AmazonEKSAdminPolicy`        | 대부분의 관리자 작업 권한                |
| `AmazonEKSEditPolicy`         | 리소스 생성, 수정, 삭제 중심의 편집 권한 |
| `AmazonEKSViewPolicy`         | 리소스 조회 중심의 읽기 권한             |

최소권한 원칙에 따라 운영자, 개발자, 조회 전용 사용자에게 동일한 관리자 권한을 부여하지 않는다.

클러스터 전체 범위로 권한을 부여해야 하는 경우에는 `type=cluster`를 사용한다.

```bash
aws eks associate-access-policy \
  --cluster-name [cluster명] \
  --region [region명] \
  --principal-arn [iam-principal-arn] \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy \
  --access-scope type=cluster
```

클러스터 전체 관리자 정책은 영향 범위가 매우 크므로 break-glass 관리자, 플랫폼 관리자 등 명확한 운영 목적이 있는 IAM 역할에만 제한적으로 부여한다.

```bash
aws eks associate-access-policy \
  --cluster-name [cluster명] \
  --region [region명] \
  --principal-arn [iam-principal-arn] \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

## Step 6: Access Entry와 연결 정책을 조회한다

클러스터에 등록된 Access Entry 목록을 확인한다.

```bash
aws eks list-access-entries \
  --cluster-name [cluster명] \
  --region [region명]
```

특정 Access Entry에 연결된 정책을 확인한다.

```bash
aws eks list-associated-access-policies \
  --cluster-name [cluster명] \
  --region [region명] \
  --principal-arn [iam-principal-arn]
```

출력 결과에서 `policyArn`과 `accessScope`가 의도한 값인지 확인한다.

#### aws-auth ConfigMap과의 관계

`API_AND_CONFIG_MAP` 모드는 기존 `aws-auth` ConfigMap과 EKS Access Entries를 함께 사용하는 전환 단계에 적합하다.

전환 시 권장 순서는 다음과 같다.

1. 현재 `aws-auth` ConfigMap에 등록된 IAM 사용자와 역할을 목록화한다.
2. 각 IAM 주체가 실제로 필요한 권한 수준을 확인한다.
3. 동일하거나 더 제한적인 Access Entry와 Access Policy를 생성한다.
4. Access Entry 기반 접근이 정상 동작하는지 검증한다.
5. 중복되거나 불필요한 `aws-auth` 매핑을 단계적으로 제거한다.

운영 중인 클러스터에서 `aws-auth` ConfigMap을 먼저 삭제하거나 대량 수정하면 접근 장애가 발생할 수 있다. 따라서 Access Entries를 검증한 뒤 점진적으로 전환해야 한다.

#### 검증 방법

권한을 부여받은 IAM 주체로 kubeconfig를 업데이트한 뒤 Kubernetes API 접근을 확인한다.

```bash
aws eks update-kubeconfig \
  --name [cluster명] \
  --region [region명] \
  --role-arn [iam-role-arn]
```

조회 권한을 부여한 경우 다음 명령이 성공해야 한다.

```bash
kubectl get pods -n [namespace명]
```

네임스페이스 범위로만 권한을 부여했다면 다른 네임스페이스 접근은 실패해야 한다.

```bash
kubectl get pods -n [다른-namespace명]
```

편집 권한을 부여하지 않은 계정이라면 생성 또는 삭제 작업은 실패해야 한다.

```bash
kubectl delete pod [pod명] -n [namespace명]
```

## Risk 및 미적용 시 영향

- **Risk:** 과도한 관리자 그룹이 매핑되어 있거나, 퇴사자 또는 불필요한 IAM 역할이 남아 있으면 해당 신분을 통해 클러스터 관리자 권한을 획득할 수 있다.
- **운영 장애:** `aws-auth` ConfigMap을 수동 편집하다가 YAML 형식 오류나 관리자 ARN 삭제가 발생하면 정상적인 클러스터 접근이 차단될 수 있다.
- **영향 범위:** 클러스터 접근 불가, 불필요한 관리자 권한 부여, 감사 추적 어려움, 권한 회수 누락, Kubernetes 리소스 무단 변경 가능성
- **심각도:** **높음**. 클러스터 인증과 관리자 접근 권한은 EKS 운영의 핵심 통제 지점이며, 잘못 관리되면 전체 클러스터의 통제권에 직접 영향을 준다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부 및 예상 규모:** 없음. EKS Access Entries와 Access Policy 연결 자체에는 별도 비용이 발생하지 않는다.
- **스픽스 vs 적용 도구 선택 및 비용 차이:** 필수 비용 없음. 대규모 환경에서는 Terraform, CloudFormation, AWS CDK 같은 IaC 도구로 Access Entry를 코드화하여 관리할 수 있다.

## 참고 자료

- [Amazon EKS - Grant IAM users access to Kubernetes with EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Amazon EKS - Associate access policies with access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-policies.html)
- [Amazon EKS - Changing authentication mode](https://docs.aws.amazon.com/eks/latest/userguide/setting-up-access-entries.html)
- [Amazon EKS Best Practices - Identity and Access Management](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [Kubernetes - Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)

## 연결된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.1 Ensure that the cluster-admin role is only used where required`
  클러스터 관리자 권한은 필요한 경우에만 제한적으로 사용해야 하며, 일반 사용자나 역할에는 필요한 수준의 권한만 부여해야 한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.3 Minimize wildcard use in Roles and ClusterRoles`
  Kubernetes 권한 설계 시 불필요한 wildcard 권한을 줄여 권한 확대 가능성을 낮춰야 한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.6 Ensure that Service Account Tokens are only mounted where necessary`
  IAM 신분과 Kubernetes 신분의 권한 경계를 명확히 하고, 워크로드 접근 권한과 사용자 접근 권한을 분리해야 한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `RBAC and least privilege`
  사용자와 역할에는 업무 수행에 필요한 최소 권한만 부여하고, 관리자 권한은 엄격히 제한할 것을 권고한다.

## Assessment 체크리스트

- [ ] 클러스터 인증 모드가 `API_AND_CONFIG_MAP`로 설정되어 있는가?
- [ ] 권한을 부여할 IAM 사용자 또는 IAM 역할 ARN을 정확히 확인했는가?
- [ ] IAM Principal별 Access Entry가 생성되어 있는가?
- [ ] 각 Access Entry에 적절한 AWS 관리형 Access Policy가 연결되어 있는가?
- [ ] 네임스페이스 범위 권한이 필요한 경우 `accessScope`가 `namespace`로 제한되어 있는가?
- [ ] 클러스터 전체 권한이 필요한 경우 사유와 대상 IAM 역할이 명확한가?
- [ ] 권한을 부여받은 IAM 주체로 실제 `kubectl` 접근 테스트를 수행했는가?
