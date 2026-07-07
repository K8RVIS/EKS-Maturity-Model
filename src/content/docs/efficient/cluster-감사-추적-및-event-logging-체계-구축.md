---
title: "Cluster 감사 추적 및 Event Logging 체계를 구축한다"
description: "Prometheus/Grafana 모니터링은 \"지금 클러스터가 어떤 상태인가\"를 보여준다. 하지만 보안 사고가 발생했을 때 \"누가 언제 무엇을 했는가\"를 사후에 증명하는 것은 전혀 다른 문제다. 이를 가능하게 하는 것이 감사 로그(Audit Log)와 이벤트 추적 체계"
phase: "Efficient"
domain: "Pod 보안"
order: 60
sidebar:
  order: 60
---

## 왜 필요한가

Prometheus/Grafana 모니터링은 "지금 클러스터가 어떤 상태인가"를 보여준다. 하지만 보안 사고가 발생했을 때 "누가 언제 무엇을 했는가"를 사후에 증명하는 것은 전혀 다른 문제다. 이를 가능하게 하는 것이 감사 로그(Audit Log)와 이벤트 추적 체계다.

EKS 클러스터에는 두 계층의 로그가 존재한다.

- **제어 평면 로그 (Control Plane Logs):** Kubernetes API 서버, 인증, RBAC, 스케줄러, 컨트롤러가 수행한 모든 작업 기록. 기본값으로는 비활성화되어 있다.
- **AWS API 로그 (CloudTrail):** EKS 클러스터 생성/삭제, IAM 권한 변경, ECR push, S3 접근 등 AWS 레벨의 모든 API 호출 기록.

이 두 계층이 함께 활성화되어야 다음 시나리오를 추적할 수 있다.

- 공격자가 `kubectl exec`으로 컨테이너에 진입한 기록
- 서비스 계정이 Secret을 비정상적으로 반복 조회한 기록
- 누군가 RBAC Role을 무단 변경한 기록
- 반복된 인증 실패(401/403)가 특정 IP에서 발생한 기록

이 단계에서는 5종 EKS 제어 평면 로그를 CloudWatch로 수집하고, CloudTrail로 AWS API를 이중 추적하며, 4가지 보안 이벤트 패턴을 Metric Filter + CloudWatch Alarm + SNS로 실시간 탐지한다.

---

## 수행 방법

**사전 조건**

- EKS 클러스터가 배포되어 있어야 한다.
- Terraform으로 EKS 모듈과 환경 설정에 접근할 수 있어야 한다.
- SNS 알림을 수신할 이메일 주소가 준비되어 있어야 한다.

### Step 1: 현황을 파악한다

EKS 클러스터의 제어 평면 로그 활성화 여부를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws eks describe-cluster \
  --name <CLUSTER_NAME> \
  --region ap-northeast-2 \
  --query 'cluster.logging.clusterLogging'
```

기대 결과(미적용 시): `enabled` 배열이 비어 있거나 항목이 없다.

CloudTrail 활성화 여부를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws cloudtrail describe-trails \
  --region ap-northeast-2 \
  --query 'trailList[*].{Name:Name,S3:S3BucketName,MultiRegion:IsMultiRegionTrail}'
```

### Step 2: EKS 제어 평면 로그를 활성화한다

`modules/eks/main.tf`의 EKS 클러스터 리소스에 로그 타입을 추가한다.

```hcl
resource "aws_eks_cluster" "this" {
  # ... 기존 설정 ...

  enabled_cluster_log_types = var.enabled_cluster_log_types
}
```

`modules/eks/variables.tf`에 변수를 추가한다.

```hcl
variable "enabled_cluster_log_types" {
  description = "활성화할 EKS 제어 평면 로그 타입 목록"
  type        = list(string)
  default     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  validation {
    condition = alltrue([
      for t in var.enabled_cluster_log_types :
      contains(["api", "audit", "authenticator", "controllerManager", "scheduler"], t)
    ])
    error_message = "유효한 로그 타입: api, audit, authenticator, controllerManager, scheduler"
  }
}
```

`environments/infra/terraform.tfvars`에 값을 설정한다.

```hcl
enabled_cluster_log_types    = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
log_retention_days           = 90
cloudtrail_s3_retention_days = 365
alert_email                  = "<수신자-이메일>"
```

### Step 3: CloudTrail과 S3 버킷을 구성한다

`modules/logging/main.tf`를 신규 생성한다.

```hcl
# CloudTrail 로그 저장용 S3 버킷
resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "${var.project_name}-cloudtrail-logs"
  force_destroy = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    expiration { days = var.cloudtrail_s3_retention_days }
  }
}

resource "aws_cloudtrail" "this" {
  name                          = "${var.project_name}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_cw.arn
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/${var.project_name}"
  retention_in_days = var.log_retention_days
}
```

### Step 4: Metric Filter와 보안 알람을 구성한다

4가지 보안 이벤트를 CloudWatch Metric Filter로 감지하고 Alarm과 SNS 알림을 연결한다.

```hcl
locals {
  security_filters = {
    unauthorized-api-calls = {
      pattern   = "{ ($.responseStatus.code = 401) || ($.responseStatus.code = 403) }"
      threshold = 10
      period    = 300
      desc      = "5분 내 401/403 응답 10건 초과: 반복 인증 실패 또는 권한 없는 접근 시도"
    }
    pod-exec = {
      pattern   = "{ $.objectRef.subresource = \"exec\" }"
      threshold = 1
      period    = 60
      desc      = "kubectl exec 감지: 컨테이너 직접 진입 시도"
    }
    secret-access = {
      pattern   = "{ ($.objectRef.resource = \"secrets\") && (($.verb = \"get\") || ($.verb = \"list\") || ($.verb = \"watch\")) }"
      threshold = 20
      period    = 300
      desc      = "5분 내 Secret 조회 20건 초과: 서비스 계정 토큰 탈취 후 정찰 시도"
    }
    rbac-changes = {
      pattern   = "{ (($.objectRef.resource = \"roles\") || ($.objectRef.resource = \"clusterroles\") || ($.objectRef.resource = \"rolebindings\") || ($.objectRef.resource = \"clusterrolebindings\")) && (($.verb = \"create\") || ($.verb = \"update\") || ($.verb = \"patch\") || ($.verb = \"delete\")) }"
      threshold = 1
      period    = 60
      desc      = "RBAC Role/Binding 변경 감지: 권한 상승 시도"
    }
  }
}

resource "aws_cloudwatch_metric_filter" "security" {
  for_each       = local.security_filters
  name           = "${var.project_name}-${each.key}"
  log_group_name = "/aws/eks/${var.cluster_name}/cluster"
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.key
    namespace = "${var.project_name}/SecurityEvents"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "security" {
  for_each            = local.security_filters
  alarm_name          = "${var.project_name}-${each.key}"
  alarm_description   = each.value.desc
  metric_name         = each.key
  namespace           = "${var.project_name}/SecurityEvents"
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.security_alerts.arn]
}

resource "aws_sns_topic" "security_alerts" {
  name = "${var.project_name}-security-alerts"
}

resource "aws_sns_topic_subscription" "security_alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.security_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
```

### Step 5: 변경 사항을 적용한다

```bash
terraform init
terraform plan
terraform apply
```

Terraform apply 후 수신 이메일로 SNS 구독 확인 메일이 발송된다. **반드시 "Confirm subscription" 링크를 클릭해야 알림이 수신된다.**

---

## 검증 방법

EKS 제어 평면 로그가 활성화되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws eks describe-cluster \
  --name <CLUSTER_NAME> \
  --region ap-northeast-2 \
  --query 'cluster.logging.clusterLogging[?enabled==`true`]'
```

기대 결과: `api`, `audit`, `authenticator`, `controllerManager`, `scheduler` 5개 타입이 모두 `enabled: true`로 표시된다.

CloudWatch 로그 그룹에 EKS 로그가 수집되는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws logs describe-log-groups \
  --log-group-name-prefix "/aws/eks/<CLUSTER_NAME>" \
  --region ap-northeast-2 \
  --query 'logGroups[*].{Name:logGroupName,Retention:retentionInDays}'
```

기대 결과: `/aws/eks/<CLUSTER_NAME>/cluster` 로그 그룹이 보존 기간 90일로 존재한다.

CloudTrail이 정상 동작하는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws cloudtrail get-trail-status \
  --name <project_name>-trail \
  --region ap-northeast-2 \
  --query '{IsLogging:IsLogging,LatestDelivery:LatestDeliveryTime}'
```

기대 결과: `IsLogging: true`이고 `LatestDeliveryTime`이 최근 시간으로 표시된다.

Metric Filter가 정상 생성되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws logs describe-metric-filters \
  --log-group-name "/aws/eks/<CLUSTER_NAME>/cluster" \
  --region ap-northeast-2 \
  --query 'metricFilters[*].{Name:filterName,Pattern:filterPattern}'
```

기대 결과: 4개 Metric Filter(`unauthorized-api-calls`, `pod-exec`, `secret-access`, `rbac-changes`)가 표시된다.

kubectl exec 탐지를 직접 테스트한다.

```bash
# exec 이벤트 발생
kubectl exec -it <any-pod> -n team-a -- echo "test"

# CloudWatch에서 필터 매칭 확인 (수초~수분 후)
AWS_PROFILE=<PROFILE> aws logs filter-log-events \
  --log-group-name "/aws/eks/<CLUSTER_NAME>/cluster" \
  --filter-pattern '{ $.objectRef.subresource = "exec" }' \
  --region ap-northeast-2 \
  --query 'events[0].message'
```

기대 결과: exec 이벤트가 로그에 기록되고, SNS 알림 이메일이 수신된다.

**검증 완료 기준**

- EKS 제어 평면 5종 로그가 CloudWatch에 수집된다.
- CloudTrail이 `IsLogging: true` 상태이고 S3에 로그가 저장된다.
- 4개 Metric Filter가 정상 생성되어 있다.
- kubectl exec 실행 시 SNS 이메일 알림이 수신된다.
- 이메일 SNS 구독이 확인 완료(Confirmed) 상태이다.

---

## Risk 및 미적용 시 영향

- **사후 추적 불가:** 보안 사고 발생 후 공격자의 행동 경로를 재구성할 증거가 없다. 감사 로그 없이는 "언제 누가 어떤 명령을 실행했는가"를 증명할 수 없다.
- **내부자 위협 탐지 불가:** `kubectl exec`, Secret 반복 조회, RBAC 변경 같은 내부자 위협 패턴을 실시간으로 감지할 수 없다. 피해가 확산된 뒤에야 인지하게 된다.
- **규정 준수 미충족:** 보안 규정(SOC 2, PCI DSS, ISO 27001)은 클러스터 감사 로그 보관을 요구한다. 로그가 없으면 감사(audit)에서 지적 사항이 발생한다.
- **CloudTrail 미활성화 리스크:** AWS 레벨의 API 호출이 추적되지 않아 IAM 권한 남용, ECR push 이력, S3 접근 등을 파악할 수 없다.
- **심각도:** **높음**. 감사 추적 체계 없이는 보안 사고의 원인 분석과 책임 귀속이 불가능하다.

---

## 발생 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 장해윤 |
| AWS 추가 비용 | CloudWatch Logs 수집: GB당 약 $0.50. CloudTrail: 첫 번째 트레일 무료, 추가 트레일 이벤트당 과금. S3 스토리지: 365일 로그 보관 비용 발생 |
| 도구 비용 | 없음 (AWS 네이티브 서비스) |
| 운영 고려사항 | 로그 보존 기간(90일/365일)은 조직 보안 정책과 규정 요건에 맞게 조정한다. 초기에는 Metric Filter 임계값이 과민하게 설정되어 알림이 다량 발생할 수 있다. 운영 패턴 파악 후 임계값을 조정한다. |

---

## 참고 자료

- [Amazon EKS - Control plane logging](https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html)
- [AWS CloudTrail - Getting started](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-getting-started.html)
- [CloudWatch - Using metric filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Detecting security issues](https://docs.aws.amazon.com/eks/latest/best-practices/detective.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  API 서버 감사 로그 활성화, 감사 로그 보관 정책 수립, 인증 실패 및 RBAC 변경 모니터링을 필수 항목으로 요구한다. 이 단계의 5종 제어 평면 로그와 4개 Metric Filter는 이 요건을 직접 충족한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  클러스터 내 모든 API 호출에 대한 감사 로그를 수집하고, 이상 행위를 실시간으로 탐지하는 체계를 갖출 것을 권고한다. CloudTrail과 CloudWatch Metric Filter의 조합이 이 지침의 탐지 요건을 이행한다.
- **AWS EKS Best Practices**
  EKS 제어 평면 로그를 CloudWatch Logs로 수집하고, CloudTrail로 AWS API 호출을 이중 추적하며, 의심스러운 이벤트에 대한 알림 체계를 갖추도록 권장한다.


## 적용 시 체크리스트

- [ ] EKS 제어 평면 5종 로그(`api`, `audit`, `authenticator`, `controllerManager`, `scheduler`)가 활성화되어 있는가?
- [ ] CloudWatch Log Group에 EKS 로그가 수집되고 보존 기간이 설정되어 있는가?
- [ ] CloudTrail이 `IsLogging: true` 상태이고 S3에 로그가 저장되는가?
- [ ] S3 버킷의 CloudTrail 로그가 KMS 암호화되어 있는가?
- [ ] 4개 Metric Filter(`unauthorized-api-calls`, `pod-exec`, `secret-access`, `rbac-changes`)가 생성되어 있는가?
- [ ] CloudWatch Alarm과 SNS Topic이 연결되어 있는가?
- [ ] SNS 이메일 구독이 확인 완료(Confirmed) 상태인가?
- [ ] kubectl exec 실행 시 SNS 알림이 수신되는가?

---
