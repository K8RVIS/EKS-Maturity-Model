# Pod별 IAM Role 부여를 통해 워크로드별 AWS 권한을 분리한다

> **Phase:** Efficient
>
> **보안 영역:** 접근 제어
>
> **대상:** AWS API를 호출하는 Kubernetes Pod와 ServiceAccount
>
> **제어 목적:** Pod가 필요한 AWS 리소스에만 접근하도록 ServiceAccount 단위로 IAM Role을 분리한다.

---

## 왜 필요한가

EKS에서 실행되는 Pod가 S3, Secrets Manager, SQS, DynamoDB, KMS 같은 AWS 리소스에 접근해야 하는 경우가 있다. 이때 Node IAM Role에 모든 권한을 부여하면 같은 Node 위에서 실행되는 여러 Pod가 과도한 AWS 권한을 공유하게 된다.

예를 들어 특정 애플리케이션 Pod가 S3 버킷의 일부 prefix만 읽어야 하는데 Node IAM Role에 S3 전체 접근 권한이 있다면, **해당 Pod가 침해되었을 때 의도하지 않은 S3 객체 조회, 수정, 삭제로 이어질 수 있다. 또한 어떤 워크로드가 어떤 AWS 권한을 사용하는지 추적하기도 어렵다.**

Pod별 IAM Role 부여는 Kubernetes ServiceAccount와 AWS IAM Role을 연결해 워크로드 단위로 AWS 권한을 분리하는 방식이다. 이번 실습에서는 **EKS Pod Identity**를 사용해 특정 namespace의 ServiceAccount와 S3 접근용 IAM Role을 연결했다.

이번 실습의 핵심은 다음과 같다.

- S3 접근이 필요한 Pod 전용 ServiceAccount를 만든다.
- 해당 ServiceAccount에만 S3 접근 IAM Role을 연결한다.
- IAM Policy는 특정 S3 버킷과 prefix 범위로 제한한다.
- Pod 안에서 AWS CLI 또는 SDK로 S3 접근이 되는지 검증한다.
- 다른 ServiceAccount나 기본 ServiceAccount에서는 같은 S3 접근이 되지 않는지 확인한다.
- Node IAM Role에 S3 권한을 몰아주지 않고 워크로드 단위 권한을 분리한다.

S3를 기준으로 실습했지만 이 방식은 S3 전용이 아니다. Pod가 AWS API를 호출해야 한다면 같은 구조를 Secrets Manager, SQS, DynamoDB, KMS, EventBridge, CloudWatch 등 다른 AWS 리소스에도 적용할 수 있다. 차이는 IAM Policy의 `Action`과 `Resource` 범위뿐이다.

## Scope

이번 항목에 포함되는 작업:

- EKS Pod Identity Agent 설치 확인
- S3 접근용 IAM Policy 생성
- S3 접근용 IAM Role 생성
- Pod Identity용 trust policy 구성
- Kubernetes ServiceAccount 생성
- ServiceAccount와 IAM Role을 `aws_eks_pod_identity_association`으로 연결
- S3 접근 테스트 Pod 실행
- 허용된 ServiceAccount와 허용되지 않은 ServiceAccount의 권한 차이 검증
- IRSA와 EKS Pod Identity의 선택 기준 정리

## 수행 방법

아래 절차는 S3 접근이 필요한 애플리케이션 Pod를 기준으로 한다. Terraform으로 구성하는 경우 핵심 리소스는 다음 순서로 구성한다.

```text
EKS Pod Identity Agent
→ IAM Policy
→ IAM Role
→ Kubernetes ServiceAccount
→ EKS Pod Identity Association
→ 테스트 Pod
→ S3 접근 검증
```

### 사전 조건

- EKS 클러스터가 생성되어 있어야 한다.
- Worker node는 EKS Pod Identity를 지원하는 환경이어야 한다.
- Terraform 실행 주체는 IAM Role, IAM Policy, EKS Pod Identity Association, Kubernetes ServiceAccount를 생성할 수 있어야 한다.
- 테스트용 S3 버킷 또는 prefix가 준비되어 있어야 한다.
- Pod에서 AWS CLI 또는 AWS SDK를 사용할 수 있어야 한다.

### Step 1: EKS Pod Identity Agent를 설치한다

EKS Pod Identity를 사용하려면 클러스터에 `eks-pod-identity-agent` 애드온이 필요하다.

Terraform 예시:

```hcl
resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = data.terraform_remote_state.infra.outputs.cluster_name
  addon_name   = "eks-pod-identity-agent"
}
```

검증 명령:

```bash
aws eks describe-addon \
  --cluster-name [cluster-name] \
  --addon-name eks-pod-identity-agent \
  --region [region] \
  --query "addon.status" \
  --output text
```

기대 결과:

```text
ACTIVE
```

### Step 2: S3 접근 범위를 정의한다

먼저 Pod가 접근해야 하는 S3 범위를 정한다.

예시:

```text
Bucket: [s3-bucket명]
Prefix: [허용-prefix]/*
```

권한은 가능한 구체적으로 제한한다.

허용 예시:

- `s3:ListBucket`은 특정 bucket에만 허용
- `s3:GetObject`, `s3:PutObject`는 특정 prefix에만 허용
- 실습 목적이 읽기 전용이면 `s3:PutObject`, `s3:DeleteObject`는 제외

### Step 3: S3 접근용 IAM Policy를 생성한다

읽기 전용 실습 예시:

```hcl
data "aws_iam_policy_document" "s3_reader" {
  statement {
    effect = "Allow"

    actions = [
      "s3:ListBucket",
    ]

    resources = [
      "arn:aws:s3:::[s3-bucket명]",
    ]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["[허용-prefix]/*"]
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "s3:GetObject",
    ]

    resources = [
      "arn:aws:s3:::[s3-bucket명]/[허용-prefix]/*",
    ]
  }
}

resource "aws_iam_policy" "s3_reader" {
  name   = "[cluster-name]-[namespace명]-s3-reader"
  policy = data.aws_iam_policy_document.s3_reader.json
}
```

읽기/쓰기 실습이 필요하면 `s3:PutObject`를 추가할 수 있다. 삭제 권한인 `s3:DeleteObject`는 실습 목적이 명확하지 않다면 제외하는 것이 좋다.

### Step 4: Pod Identity용 IAM Role을 생성한다

EKS Pod Identity에서 사용할 IAM Role은 `pods.eks.amazonaws.com` 서비스 Principal을 신뢰해야 한다.

```hcl
data "aws_iam_policy_document" "s3_pod_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    actions = [
      "sts:AssumeRole",
      "sts:TagSession",
    ]
  }
}

resource "aws_iam_role" "s3_reader" {
  name               = "[cluster-name]-[namespace명]-s3-reader"
  assume_role_policy = data.aws_iam_policy_document.s3_pod_assume_role.json
}

resource "aws_iam_role_policy_attachment" "s3_reader" {
  role       = aws_iam_role.s3_reader.name
  policy_arn = aws_iam_policy.s3_reader.arn
}
```

이 Role은 특정 ServiceAccount에 연결되기 전까지 Pod가 사용할 수 없다.

### Step 5: S3 접근용 ServiceAccount를 생성한다

S3 접근이 필요한 Pod 전용 ServiceAccount를 만든다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader
  namespace: "[namespace명]"
automountServiceAccountToken: false
```

Terraform으로 생성하는 경우:

```hcl
resource "kubernetes_service_account" "s3_reader" {
  metadata {
    name      = "s3-reader"
    namespace = "[namespace명]"
  }

  automount_service_account_token = false
}
```

`automountServiceAccountToken: false`는 Kubernetes API token 자동 마운트를 줄이기 위한 설정이다. AWS 자격 증명은 Pod Identity 경로로 제공되므로, Kubernetes API token이 항상 필요한 것은 아니다.

### Step 6: ServiceAccount와 IAM Role을 연결한다

`aws_eks_pod_identity_association`으로 namespace, ServiceAccount, IAM Role을 연결한다.

```hcl
resource "aws_eks_pod_identity_association" "s3_reader" {
  cluster_name    = "[cluster-name]"
  namespace       = "[namespace명]"
  service_account = "s3-reader"
  role_arn        = aws_iam_role.s3_reader.arn

  depends_on = [
    aws_eks_addon.pod_identity_agent,
    aws_iam_role_policy_attachment.s3_reader,
  ]
}
```

이 연결이 생성되면 `[namespace명]` namespace의 `s3-reader` ServiceAccount를 사용하는 Pod만 해당 IAM Role을 사용할 수 있다.

### Step 7: S3 접근 테스트 Pod를 실행한다

AWS CLI가 포함된 이미지로 테스트 Pod를 실행한다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: s3-reader-test
  namespace: "[namespace명]"
spec:
  serviceAccountName: s3-reader
  automountServiceAccountToken: false
  containers:
    - name: awscli
      image: public.ecr.aws/aws-cli/aws-cli:2
      command: ["sleep", "3600"]
```

적용:

```bash
kubectl apply -f s3-reader-test.yaml
```

Pod 상태 확인:

```bash
kubectl get pod s3-reader-test -n [namespace명]
```

### Step 8: Pod 내부에서 S3 접근을 검증한다

Pod 내부에서 현재 caller identity를 확인한다.

```bash
kubectl exec -n [namespace명] s3-reader-test -- aws sts get-caller-identity
```

기대 결과:

```text
Arn: arn:aws:sts::[account-id]:assumed-role/[cluster-name]-[namespace명]-s3-reader/...
```

허용된 S3 prefix 접근 확인:

```bash
kubectl exec -n [namespace명] s3-reader-test -- \
  aws s3 ls s3://[s3-bucket명]/[허용-prefix]/
```

기대 결과:

```text
접근 성공
```

허용되지 않은 prefix 접근 확인:

```bash
kubectl exec -n [namespace명] s3-reader-test -- \
  aws s3 ls s3://[s3-bucket명]/[차단-prefix]/
```

기대 결과:

```text
AccessDenied
```

### Step 9: 다른 ServiceAccount에서는 S3 접근이 차단되는지 확인한다

기본 ServiceAccount 또는 다른 workload ServiceAccount로 테스트 Pod를 실행한다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: s3-deny-test
  namespace: "[namespace명]"
spec:
  serviceAccountName: default
  automountServiceAccountToken: false
  containers:
    - name: awscli
      image: public.ecr.aws/aws-cli/aws-cli:2
      command: ["sleep", "3600"]
```

검증:

```bash
kubectl exec -n [namespace명] s3-deny-test -- aws sts get-caller-identity
kubectl exec -n [namespace명] s3-deny-test -- aws s3 ls s3://[s3-bucket명]/[허용-prefix]/
```

기대 결과:

```text
Pod Identity Role을 받지 못하거나 S3 접근이 AccessDenied로 실패
```

이 검증으로 S3 권한이 Node 전체나 namespace 전체가 아니라 특정 ServiceAccount에만 연결되었는지 확인할 수 있다.

## S3 외 AWS 리소스에도 적용 가능한가

가능하다. Pod Identity는 특정 AWS 서비스 전용 기능이 아니라 Pod에 IAM Role 기반 임시 자격 증명을 제공하는 방식이다. 따라서 IAM Policy만 바꾸면 여러 AWS 리소스에 적용할 수 있다.

예시:

| AWS 리소스      | 예시 권한                                                        |
| --------------- | ---------------------------------------------------------------- |
| S3              | `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`                  |
| Secrets Manager | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` |
| DynamoDB        | `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Query`         |
| SQS             | `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`     |
| KMS             | `kms:Decrypt`, `kms:Encrypt`                                     |
| CloudWatch      | `cloudwatch:PutMetricData`                                       |

중요한 점은 ServiceAccount별로 IAM Role을 분리하고, IAM Policy의 `Action`과 `Resource`를 실제 필요한 범위로 제한하는 것이다.

## IRSA와 EKS Pod Identity 선택 기준

EKS Pod Identity는 많은 EKS 환경에서 IRSA를 대체할 수 있다. ServiceAccount annotation과 OIDC trust policy를 직접 관리하는 IRSA보다, EKS API의 Pod Identity Association으로 연결을 관리할 수 있어 운영이 단순해지는 장점이 있다.

다만 모든 환경에서 IRSA를 완전히 대체할 수 있는 것은 아니다.

### Pod Identity로 대체하기 좋은 환경

- Amazon EKS 관리형 클러스터를 사용한다.
- Pod가 Linux EC2 worker node에서 실행된다.
- 클러스터에 `eks-pod-identity-agent` 애드온을 설치할 수 있다.
- AWS SDK 또는 AWS CLI가 Pod Identity credential provider를 지원하는 버전이다.
- Terraform, AWS CLI, eksctl 등으로 `aws_eks_pod_identity_association`을 관리할 수 있다.

### IRSA가 계속 필요한 환경

- Amazon EKS Anywhere 환경
- AWS Outposts 환경
- 자체 구축 Kubernetes 클러스터 또는 EC2 위에 직접 설치한 Kubernetes
- Fargate Pod 또는 Windows Pod처럼 EKS Pod Identity 제약에 해당하는 실행 환경
- Pod Identity Agent를 설치할 수 없는 클러스터
- 사용 중인 애플리케이션 런타임 또는 AWS SDK가 Pod Identity credential provider를 지원하지 않는 경우
- 기존 IRSA 기반 Helm chart, admission webhook, 보안 정책을 그대로 유지해야 하는 경우

정리하면, 현재 실습처럼 표준 Amazon EKS + Linux EC2 node 기반 환경에서는 Pod Identity를 우선 검토할 수 있다. 반대로 EKS 외부 Kubernetes, Fargate/Windows 제약, 구형 SDK 제약이 있으면 IRSA를 계속 사용하거나 별도 인증 방식을 유지해야 한다.

## 검증 방법

### 1. Pod Identity Agent 상태 확인

```bash
aws eks describe-addon \
  --cluster-name [cluster-name] \
  --addon-name eks-pod-identity-agent \
  --region [region] \
  --query "addon.status" \
  --output text
```

기대 결과:

```text
ACTIVE
```

### 2. Pod Identity Association 확인

```bash
aws eks list-pod-identity-associations \
  --cluster-name [cluster-name] \
  --region [region]
```

상세 확인:

```bash
aws eks describe-pod-identity-association \
  --cluster-name [cluster-name] \
  --association-id [association-id] \
  --region [region]
```

확인해야 할 값:

```text
namespace: "[namespace명]"
serviceAccount: s3-reader
roleArn: arn:aws:iam::[account-id]:role/[cluster-name]-[namespace명]-s3-reader
```

### 3. IAM Policy 범위 확인

```bash
aws iam get-policy-version \
  --policy-arn arn:aws:iam::[account-id]:policy/[cluster-name]-[namespace명]-s3-reader \
  --version-id v1
```

확인할 항목:

- S3 bucket이 특정 버킷으로 제한되어 있는가
- object ARN이 특정 prefix로 제한되어 있는가
- 불필요한 `s3:*` 또는 `Resource: "*"`가 없는가

### 4. Pod에서 IAM Role 확인

```bash
kubectl exec -n [namespace명] s3-reader-test -- aws sts get-caller-identity
```

기대 결과:

```text
assumed-role/[cluster-name]-[namespace명]-s3-reader
```

### 5. 허용/차단 S3 접근 확인

허용된 prefix:

```bash
kubectl exec -n [namespace명] s3-reader-test -- \
  aws s3 ls s3://[s3-bucket명]/[허용-prefix]/
```

차단되어야 하는 prefix:

```bash
kubectl exec -n [namespace명] s3-reader-test -- \
  aws s3 ls s3://[s3-bucket명]/[차단-prefix]/
```

### 6. 다른 ServiceAccount의 접근 차단 확인

```bash
kubectl exec -n [namespace명] s3-deny-test -- \
  aws s3 ls s3://[s3-bucket명]/[허용-prefix]/
```

기대 결과:

```text
AccessDenied 또는 AWS 자격 증명 없음
```

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** Node IAM Role에 S3 전체 권한이 있으면 하나의 Pod 침해가 전체 S3 데이터 접근으로 확대될 수 있다.
- **영향 범위:** S3 객체 조회, 업로드, 삭제, 민감 데이터 유출, 다른 팀 prefix 접근으로 이어질 수 있다.
- **심각도:** 높음. S3는 애플리케이션 데이터, 로그, 백업, 배포 산출물 등 민감한 정보를 포함할 수 있다.
- **운영 리스크:** Pod Identity Association이 잘못 연결되면 Pod가 AWS 자격 증명을 받지 못해 애플리케이션 기능이 실패할 수 있다.
- **권한 관리 리스크:** IAM Policy에 `s3:*` 또는 `Resource: "*"`를 사용하면 워크로드 단위 분리 효과가 약해진다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부:** EKS Pod Identity Association 자체는 별도 비용이 없다. 다만 S3 요청, 데이터 전송, 저장 비용은 별도로 발생한다.
- **운영 부담:** ServiceAccount와 IAM Role 매핑을 워크로드별로 관리해야 한다.
- **자동화 필요성:** 운영 환경에서는 ServiceAccount 이름, IAM Role 이름, S3 prefix naming convention을 표준화하는 것이 좋다.
- **검토 필요성:** IAM Policy는 코드 리뷰에서 `Action`, `Resource`, `Condition` 범위를 반드시 확인해야 한다.

## Assessment 체크리스트

- [ ] EKS Pod Identity Agent가 설치되어 있고 `ACTIVE` 상태인가?
- [ ] AWS 리소스 접근이 필요한 Pod 전용 ServiceAccount가 분리되어 있는가?
- [ ] ServiceAccount와 IAM Role이 Pod Identity Association으로 연결되어 있는가?
- [ ] IAM Policy가 특정 S3 bucket과 prefix로 제한되어 있는가?
- [ ] Pod 내부에서 `aws sts get-caller-identity` 결과가 전용 IAM Role로 확인되는가?
- [ ] 허용된 S3 prefix 접근은 성공하는가?
- [ ] 허용되지 않은 S3 bucket 또는 prefix 접근은 실패하는가?
- [ ] 다른 ServiceAccount 또는 default ServiceAccount에서는 같은 S3 접근이 차단되는가?

## 참고 자료

- [Amazon EKS Pod Identities](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [Amazon EKS Pod Identity 작동 방식](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-how-it-works.html)
- [Amazon EKS Best Practices - Identity and Access Management](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [AWS IAM JSON policy elements: Resource](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html)

## 연결된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **AWS EKS Best Practices - IAM**
  워크로드별 IAM Role을 분리하고 Node Role에 과도한 권한을 부여하지 않는 것을 권장한다.
- **Kubernetes ServiceAccount 최소 권한 원칙**
  Pod가 필요한 ServiceAccount만 사용하고, 불필요한 Kubernetes API token 노출을 줄인다.
- **CIS Kubernetes Benchmark**
  ServiceAccount token 자동 마운트와 과도한 권한 부여를 줄이는 방향의 통제를 권장한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  워크로드 ID와 권한 범위를 명확히 분리하고, 침해 시 영향 범위를 제한할 것을 권장한다.
