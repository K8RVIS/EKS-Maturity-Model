---
title: "Secret 접근을 감사하고 추적한다"
description: "Kubernetes Secret과 AWS Secrets Manager는 민감정보를 코드와 매니페스트에서 분리하기 위한 핵심 저장소다. 하지만 Secret 저장 위치를 안전하게 바꾸는 것만으로는 충분하지 않다. 누가 언제 어떤 Secret을 조회했는지 추적할 수 없으면 "
phase: "Efficient"
domain: "데이터 보호"
difficulty: "★★☆"
owner: "공통 (전체 실습)"
order: 40
sidebar:
  order: 40
---

## 왜 필요한가

Kubernetes Secret과 AWS Secrets Manager는 민감정보를 코드와 매니페스트에서 분리하기 위한 핵심 저장소다. 하지만 Secret 저장 위치를 안전하게 바꾸는 것만으로는 충분하지 않다. 누가 언제 어떤 Secret을 조회했는지 추적할 수 없으면 권한 오남용, 사고 조사, 컴플라이언스 대응이 모두 어려워진다.

Secret 접근 감사는 두 계층을 함께 봐야 한다.

- Kubernetes API를 통해 `secrets` 리소스를 `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`한 행위
- AWS Secrets Manager의 원본 Secret을 `GetSecretValue`, `BatchGetSecretValue`로 조회한 행위

 Efficient 단계에서는 모든 namespace의 Secret API 접근을 공통 감사 대상으로 보고, 필요할 때 namespace, Secret 이름, 사용자, IAM ARN, source IP 기준으로 좁혀서 분석할 수 있어야 한다.

이 항목의 목표는 다음과 같다.

- EKS control plane audit log로 Kubernetes Secret 접근 이력을 남긴다.
- authenticator log로 Kubernetes 사용자와 IAM 인증 흐름을 함께 추적한다.
- CloudTrail Event history 또는 조직 Trail로 Secrets Manager 원본 Secret 조회 이력을 확인한다.


## 수행 방법

**사전 조건**

- EKS 클러스터를 Terraform 또는 IaC로 관리하고 있어야 한다.
- EKS control plane log를 CloudWatch Logs로 보낼 수 있는 권한이 필요하다.
- CloudWatch Logs Insights를 조회할 수 있어야 한다.
- AWS Secrets Manager를 사용하는 경우 CloudTrail Event history 또는 조직 Trail 조회 권한이 필요하다.
- 감사 로그 보존 기간, 비용, 조회 권한을 운영 정책으로 정해야 한다.

### **Step 1: EKS control plane audit/authenticator 로그를 활성화한다**

EKS 클러스터의 `enabled_cluster_log_types`에 `audit`, `authenticator`를 포함한다.

```hcl
variable "cluster_enabled_log_types" {
  description = "EKS control plane log types enabled for audit visibility."
  type        = list(string)
  default     = ["audit", "authenticator"]

  validation {
    condition = alltrue([
      for log_type in var.cluster_enabled_log_types :
      contains(["api", "audit", "authenticator", "controllerManager", "scheduler"], log_type)
    ])
    error_message = "Valid EKS control plane log types are api, audit, authenticator, controllerManager, scheduler."
  }
}
```

EKS 클러스터 리소스에는 해당 변수를 연결한다.

```hcl
resource "aws_eks_cluster" "this" {
  name                      = local.cluster_name
  role_arn                  = aws_iam_role.cluster.arn
  version                   = var.kubernetes_version
  enabled_cluster_log_types = var.cluster_enabled_log_types
}
```

`audit` 로그는 Kubernetes API 요청의 주체, verb, objectRef, 응답 코드, source IP를 확인하기 위한 핵심 로그다. `authenticator` 로그는 IAM principal이 Kubernetes 사용자로 인증되는 과정을 추적할 때 사용한다.

### **Step 2: Control Plane Log Group을 명시적으로 관리한다**

CloudWatch Log Group은 클러스터 이름에 맞춰 생성하고 retention을 설정한다. 실습 환경에서는 비용을 고려해 7일을 둘 수 있지만, 운영 환경에서는 사고 조사와 규정 요구사항에 맞춰 30일, 90일, 180일 이상을 검토한다.

```hcl
locals {
  control_plane_log_group_name = "/aws/eks/${local.cluster_name}/cluster"
}

resource "aws_cloudwatch_log_group" "eks_control_plane" {
  name              = local.control_plane_log_group_name
  retention_in_days = var.control_plane_log_retention_days

  tags = merge(
    local.common_tags,
    {
      Name = "${local.cluster_name}-control-plane-logs"
    }
  )
}
```

클러스터 생성 전에 Log Group이 준비되도록 의존성을 둔다.

```hcl
resource "aws_eks_cluster" "this" {
  # ...

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_cloudwatch_log_group.eks_control_plane,
  ]
}
```

출력값으로 감사 로그 설정을 노출하면 운영자가 적용 여부를 쉽게 확인할 수 있다.

```hcl
output "control_plane_log_group_name" {
  description = "CloudWatch Log Group name for EKS control plane logs."
  value       = module.eks.control_plane_log_group_name
}

output "cluster_enabled_log_types" {
  description = "Enabled EKS control plane log types."
  value       = module.eks.cluster_enabled_log_types
}
```

### **Step 3: 모든 namespace의 Secret API 접근을 조회한다**

CloudWatch Logs Insights에서 EKS control plane log group을 선택한 뒤 다음 쿼리를 실행한다.

```sql
fields @timestamp, verb, user.username, objectRef.namespace, objectRef.name, sourceIPs, responseStatus.code
| filter objectRef.resource = "secrets"
| filter verb in ["get", "list", "watch", "create", "update", "patch", "delete"]
| sort @timestamp desc
| limit 100
```

이 쿼리는 모든 namespace의 Secret API 접근을 대상으로 한다. 특정 namespace만 확인해야 할 때만 조건을 추가한다.

```sql
fields @timestamp, verb, user.username, user.extra.arn.0, objectRef.namespace, objectRef.name, sourceIPs, responseStatus.code
| filter objectRef.resource = "secrets"
| filter objectRef.namespace = "<namespace>"
| sort @timestamp desc
| limit 100
```

운영에서는 namespace 필터를 고정하지 말고 대시보드 변수나 쿼리 조건으로 선택할 수 있게 둔다. Secret 접근 감사의 기본 관점은 전체 클러스터이고, namespace 필터는 조사 편의를 위한 보조 조건이다.

### **Step 4: 위험도가 높은 Secret 접근 패턴을 별도 쿼리로 본다**

전체 접근 목록만으로는 이상 행위를 놓치기 쉽다. 아래 쿼리는 특히 주의할 이벤트를 빠르게 찾기 위한 예시다.

Secret 전체 나열:

```sql
fields @timestamp, user.username, user.extra.arn.0, objectRef.namespace, sourceIPs, responseStatus.code
| filter objectRef.resource = "secrets"
| filter verb = "list"
| sort @timestamp desc
| limit 100
```

Secret watch:

```sql
fields @timestamp, user.username, user.extra.arn.0, objectRef.namespace, sourceIPs, responseStatus.code
| filter objectRef.resource = "secrets"
| filter verb = "watch"
| sort @timestamp desc
| limit 100
```

실패하거나 거부된 접근:

```sql
fields @timestamp, verb, user.username, objectRef.namespace, objectRef.name, sourceIPs, responseStatus.code, responseStatus.reason
| filter objectRef.resource = "secrets"
| filter responseStatus.code >= 400
| sort @timestamp desc
| limit 100
```

system component가 아닌 사용자 또는 CI 주체의 접근:

```sql
fields @timestamp, verb, user.username, user.extra.arn.0, objectRef.namespace, objectRef.name, sourceIPs
| filter objectRef.resource = "secrets"
| filter not startswith(user.username, "system:")
| sort @timestamp desc
| limit 100
```

이상 접근 판단은 환경별 정상 운영 패턴을 함께 봐야 한다. 예를 들어 External Secrets Operator, Argo CD, controller-manager가 Secret을 읽는 행위는 정상일 수 있지만, 개발자 IAM role이 여러 namespace의 Secret을 반복적으로 `list`하는 행위는 조사 대상이다.

### **Step 5: authenticator 로그로 IAM 주체를 연결한다**

Audit log의 `user.username`만으로는 실제 AWS IAM principal을 바로 파악하기 어려운 경우가 있다. `authenticator` 로그에서 같은 시간대의 인증 이벤트를 확인해 Kubernetes 사용자와 IAM ARN을 연결한다.

```sql
fields @timestamp, @message
| filter @logStream like /authenticator/
| filter @message like /arn:aws:iam/
| sort @timestamp desc
| limit 100
```

조사할 때는 다음 정보를 함께 기록한다.

- Kubernetes username
- IAM role 또는 user ARN
- source IP
- 접근한 namespace와 Secret 이름
- verb와 response code
- 요청이 정상 운영 도구에서 발생했는지 여부

### **Step 6: AWS Secrets Manager 원본 Secret 조회를 CloudTrail로 확인한다**

Kubernetes Secret 접근과 별도로, AWS Secrets Manager의 원본 Secret을 직접 조회하는 행위도 감사해야 한다. 

- `GetSecretValue`
- `BatchGetSecretValue`

의도적으로 조회 이벤트를 만든 뒤 확인할 수 있다.

```bash
aws secretsmanager get-secret-value \
  --region <region> \
  --secret-id /eks-secure-infra/app/redis
```

```bash
aws secretsmanager batch-get-secret-value \
  --region <region> \
  --secret-id-list /eks-secure-infra/app/redis \
  --query "SecretValues[].{Name:Name,ARN:ARN,VersionId:VersionId,CreatedDate:CreatedDate}" \
  --output table
```

CloudTrail Event history 조회 예시는 다음과 같다.

```bash
aws cloudtrail lookup-events \
  --region <region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --max-results 50
```

Batch 조회도 별도로 확인한다.

```bash
aws cloudtrail lookup-events \
  --region <region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=BatchGetSecretValue \
  --max-results 50
```

운영 환경에서는 Event history만으로 충분하지 않을 수 있다. 장기 보존, 중앙 계정 수집, Athena 분석, GuardDuty/Detective 연계를 원한다면 조직 Trail 또는 CloudTrail Lake를 구성한다.

### **Step 7: 알림과 운영 절차로 연결한다**

Efficient 단계의 감사는 단순 조회에서 끝나면 효과가 제한된다. 최소한 다음 조건은 알림 또는 정기 점검 대상으로 만든다.

- 사람이 직접 Secret을 `get`, `list`, `watch`한 경우
- 특정 IAM role이 여러 namespace의 Secret을 짧은 시간에 조회한 경우
- 실패한 Secret 접근이 반복되는 경우
- 운영 시간 외 Secret 접근이 발생한 경우
- Secrets Manager `GetSecretValue`가 예상하지 않은 principal에서 발생한 경우

CloudWatch Logs Metric Filter, Logs Insights scheduled query, EventBridge, SIEM 연계를 사용할 수 있다. 알림에는 실제 Secret 값이 포함되지 않도록 주의한다.

## 검증 방법

EKS 클러스터에 로그 타입이 활성화되었는지 확인한다.

```bash
aws eks describe-cluster \
  --name <cluster-name> \
  --region <region> \
  --query 'cluster.enabledClusterLogTypes' \
  --output json
```

기대 결과:

- `audit`가 포함된다.
- `authenticator`가 포함된다.

CloudWatch Log Group retention을 확인한다.

```bash
aws logs describe-log-groups \
  --region <region> \
  --log-group-name-prefix "/aws/eks/<cluster-name>/cluster" \
  --query 'logGroups[].{Name:logGroupName,Retention:retentionInDays}' \
  --output table
```

기대 결과:

- EKS control plane log group이 존재한다.
- 사전에 정의한 `Retention`이 알맞게 반영되어 있다. 
- 운영 환경에서는 조직 보존 정책에 맞는 값이다.

Kubernetes Secret 접근 이벤트를 생성한다.

```bash
kubectl get secret -n <namespace>
kubectl get secret app-secrets -n <namespace> -o yaml
```

CloudWatch Logs Insights에서 모든 namespace 쿼리로 이벤트가 보이는지 확인한다.

```sql
fields @timestamp, verb, user.username, user.extra.arn.0, objectRef.namespace, objectRef.name, sourceIPs, responseStatus.code
| filter objectRef.resource = "secrets"
| sort @timestamp desc
| limit 20
```

기대 결과:

- `objectRef.namespace`에 테스트한 namespace가 표시된다.
- `objectRef.name`에 조회한 Secret 이름이 표시된다.
- `user.username` 또는 `user.extra.arn.0`에서 접근 주체를 추적할 수 있다.
- `responseStatus.code`가 200 또는 해당 요청 결과에 맞게 기록된다.

Secrets Manager 조회 이벤트를 확인한다.

```bash
aws cloudtrail lookup-events \
  --region <region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --max-results 10
```

기대 결과:

- 이벤트 이름이 `GetSecretValue`다.
- `Username` 또는 CloudTrail 이벤트 상세에서 호출 주체를 확인할 수 있다.
- 이벤트 시간과 테스트 조회 시간이 일치한다.

Terraform 테스트 또는 plan에서도 로그 설정을 검증한다.

```bash
terraform test
terraform plan
```

기대 결과:

- EKS module 테스트에서 `audit`, `authenticator` 활성화 조건이 통과한다.
- Control Plane Log Group retention이 변수와 일치한다.
- 기존 로그 설정이 의도치 않게 비활성화되지 않는다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 과도한 RBAC 권한을 가진 사용자가 여러 namespace의 Kubernetes Secret을 조회하고, CloudWatch에 감사 흔적이 없어 누가 언제 접근했는지 확인하지 못한다.
- **AWS 원본 Secret 탈취:** IAM 권한이 넓은 principal이 Secrets Manager의 원본 값을 `GetSecretValue`로 조회해도 CloudTrail 확인 절차가 없으면 사고 조사가 지연된다.
- **권한 오남용 탐지 실패:** `list/watch secrets` 같은 넓은 권한 사용이 정상 운영 흐름에 묻혀 장기간 발견되지 않을 수 있다.
- **컴플라이언스 리스크:** 민감정보 접근 기록을 보존하고 제시해야 하는 요구사항에 대응하기 어렵다.
- **운영 리스크:** 로그 retention이 너무 짧으면 주말이나 장기 연휴 뒤 사고를 발견했을 때 필요한 기간의 로그가 이미 삭제될 수 있다.
- **비용 리스크:** 로그를 무제한 보존하거나 불필요한 control plane log를 모두 켜면 CloudWatch 비용이 급증할 수 있다. 보존 기간과 필터링 기준을 명확히 정해야 한다.
- **심각도:** **높음**. Secret 접근은 데이터 유출과 권한 확대로 직접 이어질 수 있으며, 감사 부재는 사고 대응 시간을 크게 늘린다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부 및 예상 규모:** EKS control plane log 전송과 CloudWatch Logs 저장, Logs Insights 조회 비용이 발생한다. 실습 환경은 7일 retention으로 비용을 줄일 수 있으나, 운영 환경은 보존 정책에 따라 비용을 산정해야 한다.
- **CloudTrail 비용:** Event history 조회 자체는 기본 기능으로 사용할 수 있다. 조직 Trail, CloudTrail Lake, S3 장기 보존, Athena 분석을 추가하면 저장 및 조회 비용이 발생한다.
- **운영 비용:** 감사 쿼리 작성, 정상 접근 기준선 수립, 알림 튜닝, incident runbook 작성이 필요하다.
- **대안 비용:** SIEM, GuardDuty, Detective, OpenSearch, Datadog 같은 도구로 중앙 수집하면 분석은 쉬워지지만 도구 비용과 운영 부담이 증가한다.

## 참고 자료

- [Amazon EKS control plane logging](https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html)
- [Kubernetes Auditing](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
- [CloudWatch Logs Insights query syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)
- [AWS CloudTrail Event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html)
- [AWS Secrets Manager CloudTrail logging](https://docs.aws.amazon.com/secretsmanager/latest/userguide/monitoring-cloudtrail.html)
- [EKS Best Practices Guide - Logging](https://aws.github.io/aws-eks-best-practices/security/docs/detective/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  Secret 접근, RBAC, 감사 로그, 비정상 API 접근 추적 원칙과 연결된다.
- **[CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)**
  audit log 활성화, Secret 리소스 접근 권한 최소화, 권한 사용 추적과 연결된다.
- **[CIS Amazon EKS Benchmark](https://www.cisecurity.org/cis-benchmarks)**
  EKS control plane logging, CloudWatch Logs 보존, AWS API 감사와 연결된다.
- **[NIST SP 800-53 Rev.5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)**
  `AU-2`, `AU-6`, `AU-12`, `AC-6`와 연결된다.
- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  추적성, 탐지, 최소 권한, incident response readiness와 연결된다.

## Assessment 체크리스트

- [ ] EKS control plane log type에 `audit`가 포함되어 있는가?
- [ ] EKS control plane log type에 `authenticator`가 포함되어 있는가?
- [ ] Control Plane Log Group retention이 운영 보존 정책에 맞게 설정되어 있는가?
- [ ] Kubernetes Secret 접근을 조회하는 CloudWatch Logs Insights 쿼리가 준비되어 있는가?
- [ ] 사람이 직접 Secret을 `get/list/watch`한 이벤트를 식별할 수 있는가?
- [ ] Kubernetes username과 IAM ARN을 authenticator 로그로 연결할 수 있는가?
- [ ] Secrets Manager `GetSecretValue`와 `BatchGetSecretValue` 이벤트를 CloudTrail에서 확인할 수 있는가?
- [ ] 예상하지 않은 principal의 Secret 조회에 대한 알림 또는 정기 점검 절차가 있는가?
- [ ] 로그 조회 권한이 필요한 운영자에게만 제한되어 있는가?
- [ ] 감사 로그와 알림 메시지에 실제 Secret 값이 포함되지 않도록 관리되는가?

