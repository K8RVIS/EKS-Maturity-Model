---
title: "Break-glass 감사 자동화를 통해 긴급 관리자 접근을 JIT로 부여하고 추적한다"
description: "Break-glass 접근은 장애 대응이나 긴급 보안 조치처럼 평상시 권한으로는 해결하기 어려운 상황에서 사용하는 예외적 관리자 접근이다. 하지만 break-glass Role을 상시 관리자 권한으로 열어두면 권한 오남용, 계정 탈취, 추적 누락 위험이 커진다."
phase: "Optimized"
domain: "접근 제어"
difficulty: "미정"
owner: "공통 (전체 실습)"
order: 10
sidebar:
  order: 10
---

## 왜 필요한가

Break-glass 접근은 장애 대응이나 긴급 보안 조치처럼 평상시 권한으로는 해결하기 어려운 상황에서 사용하는 예외적 관리자 접근이다. 하지만 break-glass Role을 상시 관리자 권한으로 열어두면 권한 오남용, 계정 탈취, 추적 누락 위험이 커진다.

이번 실습에서는 break-glass Role 자체는 사전에 준비하되, EKS 관리자 권한은 승인된 시간 동안만 부여하는 JIT(Just-In-Time) 방식으로 구성했다. 권한 부여 시점에는 DynamoDB에 grant 상태를 기록하고, EventBridge Scheduler가 TTL 만료 시 Lambda를 호출해 EKS Access Entry와 Admin Policy Association을 자동으로 회수한다.

또한 AWS 레벨에서는 CloudTrail과 EventBridge를 통해 `sts:AssumeRole` 사용을 탐지하고 SNS Email로 알림을 보낸다. Kubernetes 레벨에서는 EKS control plane의 `api`, `audit`, `authenticator` 로그를 CloudWatch Logs로 수집하고, 고위험 Kubernetes API 요청을 CloudWatch Metric Filter/Alarm으로 추가 탐지한다.

이번 실습의 목표는 다음과 같다.

- break-glass Role을 사전에 생성한다.
- SSO 기반 사용자가 break-glass Role을 AssumeRole 할 수 있도록 신뢰 관계를 구성한다.
- 평상시에는 EKS 관리자 권한을 부여하지 않는다.
- 수동 JIT grant 실행 시 EKS Access Entry와 `AmazonEKSClusterAdminPolicy`를 임시 연결한다.
- TTL 만료 시 EventBridge Scheduler와 Lambda로 권한을 자동 회수한다.
- CloudTrail/EventBridge/SNS로 Role 사용을 알림 처리한다.
- EKS audit/authenticator 로그로 Kubernetes 내부 행위를 추적한다.
- 고위험 Kubernetes API 요청만 별도 필터링해 알림을 발생시킨다.
- 사후 리뷰를 통해 누가, 언제, 왜, 어떤 작업을 했는지 정리한다.

## Scope

이번 항목에 포함되는 작업:

- break-glass IAM Role 생성
- SSO Reserved Role 기반 AssumeRole 신뢰 관계 구성
- EKS control plane 로그 활성화
- CloudTrail 기반 `AssumeRole` 탐지 EventBridge Rule 구성
- SNS Email 알림 구성
- JIT 권한 상태 저장용 DynamoDB Table 구성
- 자동 회수용 Lambda 구성
- EventBridge Scheduler를 통한 자동 회수 예약
- 수동 grant 스크립트를 통한 EKS 관리자 권한 임시 부여
- EKS audit/authenticator 로그 확인
- 고위험 Kubernetes API 요청 Metric Filter/Alarm 구성

이번 항목에 포함하지 않는 작업:

- 상시 EKS 관리자 권한 부여
- Slack 알림 직접 연동
- 실제 장애 대응 프로세스 전체 자동화
- 모든 Kubernetes API 행위에 대한 SIEM 연동
- IAM Identity Center MFA 정책 자체 구성

## 수행 방법

아래 절차는 일반적인 IaC 저장소 구조를 기준으로 작성한다. 조직의 저장소 구조에 맞게 파일 경로와 모듈명을 조정한다. 핵심 구현 위치 예시는 다음과 같다.

| 구분                     | 파일                                               |
| ------------------------ | -------------------------------------------------- |
| break-glass 리소스 정의  | `[iac-root]/environments/[env]/main.tf`            |
| 변수 정의                | `[iac-root]/environments/[env]/variables.tf`       |
| output 정의              | `[iac-root]/environments/[env]/outputs.tf`         |
| 수동 JIT grant 스크립트  | `[iac-root]/scripts/manage_break_glass.py`         |
| PowerShell 래퍼 스크립트 | `[iac-root]/scripts/grant_break_glass.ps1`         |
| 자동 회수 Lambda         | `[iac-root]/lambda/break_glass_revoker.py`         |
| EKS 로그 활성화          | `[iac-root]/modules/eks/main.tf`                   |

### 사전 조건

- EKS 클러스터가 생성되어 있어야 한다.
- Terraform backend와 infra state를 읽을 수 있어야 한다.
- Terraform 실행 주체는 IAM Role, Lambda, DynamoDB, EventBridge Scheduler, SNS, CloudWatch, EKS 리소스를 생성할 권한이 있어야 한다.
- 실습자는 AWS IAM Identity Center 또는 SSO 기반 인증을 사용할 수 있어야 한다.
- SSO MFA는 IAM trust policy가 아니라 IAM Identity Center 또는 연결된 IdP에서 강제되어야 한다.
- 수동 JIT grant를 실행하는 주체는 EKS Access Entry 생성, Access Policy 연결, Scheduler 생성, DynamoDB 기록, SNS publish 권한을 가져야 한다.

### Step 1: SSO Reserved Role ARN을 확인한다

break-glass Role을 사용할 수 있는 주체는 기존 SSO Reserved Role이다.

`break_glass_trusted_principal_arns`에는 STS assumed-role ARN이 아니라 IAM Role ARN을 넣어야 한다.

올바른 예:

```text
arn:aws:iam::[account-id]:role/aws-reserved/sso.amazonaws.com/[region]/AWSReservedSSO_[permission-set명]_[suffix]
```

잘못된 예:

```text
arn:aws:sts::[account-id]:assumed-role/AWSReservedSSO_[permission-set명]_[suffix]/[user-name]
```

확인 명령:

```powershell
aws iam list-roles `
  --query "Roles[?contains(RoleName, 'AWSReservedSSO_[permission-set명]')].Arn" `
  --output text
```

### Step 2: break-glass 리소스 생성 변수를 설정한다

수동 Terraform apply 또는 workflow 변수로 다음 값을 설정한다.

```hcl
break_glass_enabled = true
break_glass_require_mfa = false

break_glass_trusted_principal_arns = [
  "arn:aws:iam::[account-id]:role/aws-reserved/sso.amazonaws.com/[region]/AWSReservedSSO_[permission-set명]_[suffix]"
]

break_glass_alert_email_addresses = [
  "[alert-email@example.com]"
]
```

SSO 기반 MFA 환경이므로 `break_glass_require_mfa = false`가 적절하다. MFA는 IAM Identity Center 또는 IdP에서 처리한다.

### Step 3: Terraform으로 break-glass 운영 리소스를 생성한다

`break_glass_enabled=true`는 EKS 관리자 권한을 바로 부여하는 설정이 아니다. 다음 운영 장치를 생성하는 설정이다.

- break-glass IAM Role
- SNS Topic 및 Email Subscription
- DynamoDB JIT grant 상태 테이블
- EventBridge Scheduler Group
- 자동 회수 Lambda
- EventBridge AssumeRole 탐지 Rule
- CloudWatch Metric Filter/Alarm
- EKS control plane log group

예시:

```powershell

terraform init

terraform apply `
  -var="break_glass_enabled=true" `
  -var="break_glass_require_mfa=false" `
  -var='break_glass_trusted_principal_arns=["arn:aws:iam::[account-id]:role/aws-reserved/sso.amazonaws.com/[region]/AWSReservedSSO_[permission-set명]_[suffix]"]' `
  -var='break_glass_alert_email_addresses=["[alert-email@example.com]"]'
```

주의:

- 기존 EKS CloudWatch log group이 이미 존재하지만 Terraform state에 없으면 import가 필요할 수 있다.
- `hashicorp/archive` provider가 추가되어 있으므로 `terraform init`을 다시 수행해야 한다.

### Step 4: Terraform output을 확인한다

수동 grant에 필요한 값은 Terraform output에서 가져온다.

```powershell
$bgRoleArn = terraform output -raw break_glass_role_arn
$topicArn = terraform output -raw break_glass_alert_topic_arn
$tableName = terraform output -raw break_glass_jit_state_table_name
$schedulerGroup = terraform output -raw break_glass_scheduler_group_name
$schedulerRoleArn = terraform output -raw break_glass_scheduler_role_arn
$revokerLambdaArn = terraform output -raw break_glass_revoker_lambda_arn
```

각 output의 의미:

| output                             | 목적                                           |
| ---------------------------------- | ---------------------------------------------- |
| `break_glass_role_arn`             | JIT로 EKS 관리자 권한을 임시 부여받을 IAM Role |
| `break_glass_alert_topic_arn`      | 권한 부여, 사용 탐지, 자동 회수 알림 SNS Topic |
| `break_glass_jit_state_table_name` | grant 상태를 저장할 DynamoDB Table             |
| `break_glass_scheduler_group_name` | 자동 회수 스케줄이 생성될 Scheduler Group      |
| `break_glass_scheduler_role_arn`   | Scheduler가 Lambda를 호출할 때 사용할 IAM Role |
| `break_glass_revoker_lambda_arn`   | TTL 만료 시 권한을 회수할 Lambda               |

### Step 5: SNS Email 구독을 승인한다

Terraform apply 후 `break_glass_alert_email_addresses`에 지정한 주소로 SNS subscription confirmation 메일이 발송된다.

메일에서 Confirm subscription을 눌러야 이후 알림이 수신된다.

### Step 6: 수동으로 JIT 권한을 부여한다

workflow를 실행할 수 없는 환경에서는 `manage_break_glass.py grant`를 직접 실행한다.

```powershell

python scripts/manage_break_glass.py grant `
  --region [region] `
  --cluster-name [cluster-name] `
  --principal-arn $bgRoleArn `
  --table-name $tableName `
  --scheduler-group $schedulerGroup `
  --scheduler-role-arn $schedulerRoleArn `
  --revoker-lambda-arn $revokerLambdaArn `
  --ttl-minutes 30 `
  --requested-by "[requester-id]" `
  --approved-by "[approver-id]" `
  --reason "[긴급 접근 사유]" `
  --sns-topic-arn $topicArn
```

이 명령이 수행하는 작업:

- EKS Access Entry 생성
- `AmazonEKSClusterAdminPolicy` 연결
- DynamoDB에 grant 상태 `ACTIVE` 저장
- EventBridge Scheduler에 자동 회수 예약 생성
- SNS Email로 권한 부여 알림 발송

### Step 7: break-glass Role을 사용해 EKS에 접근한다

SSO 로그인을 먼저 수행한다.

```powershell
aws sso login --profile <sso-profile>
```

break-glass Role로 kubeconfig를 갱신한다.

```powershell
aws eks update-kubeconfig `
  --name [cluster-name] `
  --region [region] `
  --role-arn $bgRoleArn `
  --profile <sso-profile>
```

실습 명령:

```powershell
kubectl get ns
kubectl get secrets -A
kubectl auth can-i delete secrets -A
```

`--role-arn $bgRoleArn` 사용 시 STS `AssumeRole` 이벤트가 발생하며, CloudTrail/EventBridge 탐지 대상이 된다.

### Step 8: AWS 레벨 감사 이벤트를 확인한다

CloudTrail에서 AssumeRole 이벤트를 확인한다.

```powershell
aws cloudtrail lookup-events `
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole `
  --region [region]
```

확인할 항목:

- `eventSource`: `sts.amazonaws.com`
- `eventName`: `AssumeRole`
- `requestParameters.roleArn`: `break_glass_role_arn`
- `userIdentity`: SSO 기반 호출 주체
- `eventTime`

EKS API 호출도 확인한다.

```powershell
aws cloudtrail lookup-events `
  --lookup-attributes AttributeKey=EventSource,AttributeValue=eks.amazonaws.com `
  --region [region]
```

### Step 9: Kubernetes 레벨 감사 로그를 확인한다

EKS control plane 로그 그룹:

```text
/aws/eks/[cluster-name]/cluster
```

고위험 Kubernetes API 요청 조회 예시:

```sql
fields @timestamp, user.username, verb, objectRef.resource, objectRef.subresource, objectRef.namespace, objectRef.name, requestURI, responseStatus.code
| filter @logStream like /kube-apiserver-audit/
| filter verb in ["create", "update", "patch", "delete"]
| filter objectRef.resource in ["secrets", "serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings", "pods"] or objectRef.subresource = "exec"
| sort @timestamp desc
| limit 100
```

Authenticator 로그 조회 예시:

```sql
fields @timestamp, arn, username, groups, message
| filter @logStream like /authenticator/
| filter arn like /break-glass-role-name/
| sort @timestamp desc
| limit 50
```

### Step 10: 자동 회수를 확인한다

`ttl_minutes`가 지나면 EventBridge Scheduler가 Lambda를 호출한다.

Lambda는 다음 작업을 수행한다.

- `eks:DisassociateAccessPolicy`
- `eks:DeleteAccessEntry`
- DynamoDB grant 상태를 `REVOKED`로 변경
- SNS Email로 회수 알림 발송

회수 확인:

```powershell
aws eks describe-access-entry `
  --cluster-name [cluster-name] `
  --principal-arn $bgRoleArn `
  --region [region]
```

기대 결과:

```text
ResourceNotFoundException
```

### Step 11: 사후 리뷰를 기록한다

수동 실습에서는 GitHub Issue를 직접 생성하거나 실습 기록 문서에 다음 항목을 남긴다. 실무에서는 단순히 로그를 보관하는 것보다, 해당 접근이 정말 필요한 예외 상황이었는지, 부여된 권한과 시간이 과도하지 않았는지, 작업 후 권한 회수와 후속 조치가 완료되었는지를 함께 확인하는 것이 중요하다.

- 요청자
- 승인자
- 사용 사유
- grant ID
- 시작 시각
- 만료 시각
- CloudTrail AssumeRole event ID
- EKS API 호출 내역
- Kubernetes audit/authenticator 로그 확인 결과
- 고위험 API 알림 발생 여부
- 자동 회수 확인 여부
- 정탐 / 오탐 / 정상 관리자 작업 분류
- 승인된 작업 범위를 벗어난 명령이나 리소스 접근 여부
- 동일한 상황을 일반 권한이나 자동화된 운영 절차로 처리할 수 있었는지 여부
- 권한 부여 시간, 승인 절차, 알림 대상의 개선 필요 여부
- 후속 조치

## 검증 방법

### 1. break-glass Role 생성 확인

```powershell
aws iam get-role `
  --role-name [break-glass-role-name]
```

확인할 항목:

- trust policy에 SSO Reserved Role ARN이 포함되어 있는가
- `pods.eks.amazonaws.com` 같은 잘못된 Principal이 아닌가
- SSO 환경에서 `aws:MultiFactorAuthPresent` 조건이 불필요하게 강제되어 있지 않은가

### 2. JIT grant 상태 확인

```powershell
aws dynamodb get-item `
  --table-name [break-glass-grants-table-name] `
  --key '{"grant_id":{"S":"[grant-id]"}}' `
  --region [region]
```

기대 값:

```text
status: ACTIVE
expires_at: [TTL 만료 시각]
scheduler_name: [자동 회수 스케줄 이름]
```

### 3. EKS Access Entry 확인

```powershell
aws eks describe-access-entry `
  --cluster-name [cluster-name] `
  --principal-arn $bgRoleArn `
  --region [region]
```

JIT 권한 부여 중에는 Access Entry가 존재해야 한다.

### 4. Access Policy Association 확인

```powershell
aws eks list-associated-access-policies `
  --cluster-name [cluster-name] `
  --principal-arn $bgRoleArn `
  --region [region]
```

기대 값:

```text
AmazonEKSClusterAdminPolicy
accessScope.type: cluster
```

### 5. 자동 회수 Lambda 로그 확인

```powershell
aws logs describe-log-groups `
  --log-group-name-prefix /aws/lambda/[break-glass-revoker-lambda-name] `
  --region [region]
```

Lambda 로그에서 다음 흐름을 확인한다.

```text
break-glass revoke started
break-glass revoke completed
```

### 6. CloudWatch Alarm 확인

```powershell
aws cloudwatch describe-alarms `
  --alarm-names [high-risk-kubernetes-api-alarm-name] `
  --region [region]
```

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** break-glass Role이 상시 EKS 관리자 권한을 갖고 있으면, SSO 계정 탈취나 잘못된 Role 사용만으로 클러스터 전체 제어가 가능해진다.
- **영향 범위:** Secret 조회, RBAC 변경, ServiceAccount 조작, Pod exec, 악성 workload 배포, 네임스페이스 전체 삭제 등으로 이어질 수 있다.
- **심각도:** 매우 높음. break-glass 권한은 클러스터 전체 관리자 권한이므로 사용 시간과 사용 주체를 엄격히 제한해야 한다.
- **운영 리스크:** 자동 회수 Lambda 또는 Scheduler 권한이 잘못 구성되면 TTL 이후에도 권한이 남을 수 있다.
- **감사 리스크:** CloudTrail과 EKS audit log가 없으면 AWS Role 사용과 Kubernetes 내부 행위를 연결해 설명하기 어렵다.

## 인적 리소스 및 비용

- **AWS 비용 발생 요소:** CloudWatch Logs 저장 비용, CloudWatch Metric/Alarm 비용, DynamoDB 소량 사용 비용, Lambda 호출 비용, EventBridge Scheduler 비용, SNS Email 발송 비용이 발생할 수 있다.
- **예상 비용 규모:** 실습 수준에서는 매우 작지만, EKS audit log는 이벤트 양에 따라 CloudWatch Logs 비용이 증가할 수 있다.
- **운영 부담:** trusted principal ARN, 승인자, TTL, 사후 리뷰 절차를 지속적으로 관리해야 한다.
- **자동화 필요성:** 운영 환경에서는 수동 grant보다 승인 workflow, 티켓 시스템, Slack/SIEM 연동까지 연결하는 것이 적합하다.

## Assessment 체크리스트

- [ ] break-glass Role이 사전에 생성되어 있는가?
- [ ] break-glass Role trust policy가 지정된 SSO Reserved Role만 허용하는가?
- [ ] SSO MFA가 IAM Identity Center 또는 IdP에서 강제되고 있는가?
- [ ] 평상시 break-glass Role에 EKS 관리자 Access Entry가 상시 연결되어 있지 않은가?
- [ ] JIT grant 시 EKS Access Entry와 Admin Policy Association이 생성되는가?
- [ ] grant 상태가 DynamoDB에 `ACTIVE`로 기록되는가?
- [ ] EventBridge Scheduler에 자동 회수 스케줄이 생성되는가?
- [ ] TTL 만료 후 Lambda가 권한을 회수하고 DynamoDB 상태를 `REVOKED`로 변경하는가?
- [ ] CloudTrail에서 `AssumeRole` 이벤트를 확인할 수 있는가?
- [ ] EventBridge/SNS Email로 break-glass Role 사용 알림이 전송되는가?
- [ ] EKS control plane `api`, `audit`, `authenticator` 로그가 CloudWatch Logs로 수집되는가?
- [ ] 고위험 Kubernetes API 요청이 Metric Filter/Alarm으로 탐지되는가?
- [ ] 사후 리뷰에 요청자, 승인자, 사유, 작업 내역, 회수 여부, 정탐/오탐 분류가 기록되는가?

## 참고 자료

- [Amazon EKS Control Plane Logging](https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html)
- [AWS CloudTrail User Guide](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html)
- [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)
- [Kubernetes Auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
- [Amazon EKS Best Practices - Identity and Access Management](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)

## 연결된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark**
  `cluster-admin` 권한은 필요한 경우에만 제한적으로 사용해야 하며, 상시 관리자 권한을 최소화해야 한다.
- **AWS EKS Best Practices - IAM**
  관리 권한은 최소 권한과 감사 가능성을 기준으로 분리하고, 임시 권한 사용을 권장한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  관리자 접근은 강한 인증, 감사 로깅, 최소 권한, 사후 검토 절차와 함께 운영해야 한다.
- **NIST SP 800-53**
  비상 접근 계정은 승인, 모니터링, 사용 후 검토, 권한 회수 절차를 갖춰야 한다.

