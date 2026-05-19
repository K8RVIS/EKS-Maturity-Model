# Container Image 취약점 관리

> **Phase:** Foundational
>
> **보안 영역:** Pod 보안
>
> **담당:** 장해윤
>
> **난이도:** ★★☆

---

## 왜 필요한가

**Container Image 스캔 및 차단**(ECR 향상된 스캔 + Inspector CONTINUOUS_SCAN)은 취약점을 자동으로 탐지하지만, 발견된 모든 CVE가 실제 운영 환경에서 exploit 가능한 위협은 아니다.

예를 들어 Critical 등급의 CVE라도 해당 컴포넌트가 실제 서비스 코드에서 호출되지 않거나, 네트워크 경계로 인해 외부에서 접근 불가능한 경우 실질적인 위험도는 낮아진다. 반면 Medium 등급이라도 내부 네트워크에서 접근 가능한 경우 즉각 조치가 필요할 수 있다.

따라서 Inspector findings를 담당자에게 즉시 전달하고, 실제 환경 맥락에서 영향도를 판단한 뒤 조치 우선순위를 결정하는 프로세스가 필요하다.

이 단계에서는 EventBridge와 SNS를 통해 Inspector CRITICAL/HIGH 발견을 담당자에게 알리고, 판단 기준을 정의하여 체계적인 취약점 관리 프로세스를 구성한다.

---

## 수행 방법

**사전 조건**

- **Container Image 스캔 및 차단**(Inspector v2 + ECR 향상된 스캔)이 활성화되어 있어야 한다.
- SNS 이메일 알림을 받을 담당자 이메일 주소가 준비되어 있어야 한다.

### Step 1: Inspector findings 현황을 파악한다

현재 Inspector에서 발견된 CRITICAL/HIGH 취약점을 조회해 알림이 필요한 수준인지 파악한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "resourceType": [{"comparison":"EQUALS","value":"AWS_ECR_CONTAINER_IMAGE"}],
    "severity": [
      {"comparison":"EQUALS","value":"CRITICAL"},
      {"comparison":"EQUALS","value":"HIGH"}
    ],
    "findingStatus": [{"comparison":"EQUALS","value":"ACTIVE"}]
  }' \
  --region ap-northeast-2 \
  --query 'findings[*].{Title:title,Severity:severity,Status:status,Image:resources[0].details.awsEcrContainerImage.imageHash}' \
  --output table
```

### Step 2: EventBridge Rule과 SNS Topic을 구성한다

Inspector가 CRITICAL/HIGH 취약점을 발견하면 EventBridge가 이를 감지하고 SNS를 통해 담당자에게 알린다.

```hcl
resource "aws_sns_topic" "inspector_alerts" {
  name = "${var.project_name}-inspector-alerts"
}

resource "aws_sns_topic_policy" "inspector_alerts" {
  arn = aws_sns_topic.inspector_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowEventBridgePublish"
      Effect = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action   = "sns:Publish"
      Resource = aws_sns_topic.inspector_alerts.arn
    }]
  })
}

resource "aws_cloudwatch_event_rule" "inspector_findings" {
  name        = "${var.project_name}-inspector-findings"
  description = "Inspector CRITICAL/HIGH 취약점 발견 시 SNS 알림"

  event_pattern = jsonencode({
    source      = ["aws.inspector2"]
    detail-type = ["Inspector2 Finding"]
    detail = {
      severity  = ["CRITICAL", "HIGH"]
      status    = ["ACTIVE"]
      resources = { type = ["AWS_ECR_CONTAINER_IMAGE"] }
    }
  })
}

resource "aws_cloudwatch_event_target" "inspector_to_sns" {
  rule      = aws_cloudwatch_event_rule.inspector_findings.name
  target_id = "InspectorToSNS"
  arn       = aws_sns_topic.inspector_alerts.arn

  input_transformer {
    input_paths = {
      severity    = "$.detail.severity"
      title       = "$.detail.title"
      description = "$.detail.description"
      image_uri   = "$.detail.resources[0].details.awsEcrContainerImage.imageHash"
      account_id  = "$.account"
      region      = "$.region"
    }
    input_template = <<-EOT
      "[Inspector 보안 알림] <severity> 취약점 발견

      제목: <title>
      설명: <description>
      이미지: <image_uri>
      계정: <account_id>
      리전: <region>

      AWS Console에서 Inspector 결과를 확인하고 실제 환경 영향도를 판단하세요."
    EOT
  }
}
```

### Step 3: 이메일 구독을 설정한다

`alert_email` 변수에 수신자 이메일을 지정하면 SNS 이메일 구독이 생성된다.

```hcl
resource "aws_sns_topic_subscription" "inspector_alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.inspector_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
```

Terraform apply 후 해당 이메일로 구독 확인 메일이 발송된다. **반드시 이메일 내 "Confirm subscription" 링크를 클릭해야 알림이 수신된다.**

### Step 4: 취약점 판단 기준을 수립한다

알림 수신 후 다음 기준으로 실제 환경 영향도를 판단하고 조치 우선순위를 결정한다.

| 심각도 | CVSS 점수 | 판단 기준 | 권고 조치 기한 | 근거 |
| --- | --- | --- | --- | --- |
| CRITICAL | 9.0 – 10.0 | 인증 없는 원격 코드 실행 가능, 외부 노출 여부 | 15일 이내 (KEV 등재 시 즉시) | CISA BOD 19-02, BOD 22-01 |
| HIGH | 7.0 – 8.9 | 네트워크 접근 가능성, 실제 사용 컴포넌트 여부 | 30일 이내 | CISA BOD 19-02, NIST SP 800-40 Rev 4 |
| MEDIUM | 4.0 – 6.9 | 내부 접근 경로 존재 여부 | 90일 이내 (정기 패치 주기에 포함) | NIST SP 800-40 Rev 4 |

> **참고:** 위 기한은 CISA BOD 19-02 (연방 기관 기준) 및 NIST SP 800-40 Rev 4를 기반으로 한 일반 권고치다.
> 컨테이너 환경은 이미지 재빌드가 빠르기 때문에 조직 내부적으로 더 짧은 기한을 적용할 수 있다.
> CISA KEV(Known Exploited Vulnerabilities) Catalog에 등재된 취약점은 심각도와 무관하게 14일 이내 조치를 권고한다.
>
> - [CISA BOD 19-02](https://www.cisa.gov/news-events/directives/bod-19-02-vulnerability-remediation-requirements-internet-accessible-systems)
> - [CISA BOD 22-01 + KEV Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
> - [NIST SP 800-40 Rev 4](https://csrc.nist.gov/pubs/sp/800/40/r4/final)
> - [CVSSv3.1 Severity Ratings](https://www.first.org/cvss/v3.1/specification-document)
> - [Amazon Inspector - Understanding severity levels](https://docs.aws.amazon.com/inspector/latest/user/findings-understanding-severity.html)

---

## 검증 방법

EventBridge Rule이 정상 생성되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws events describe-rule \
  --name <project_name>-inspector-findings \
  --region ap-northeast-2 \
  --query '{State:State,EventPattern:EventPattern}'
```

기대 결과: `State`가 `ENABLED`, `EventPattern`에 `aws.inspector2` 소스와 CRITICAL/HIGH severity 필터가 포함된다.

SNS Topic이 생성되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws sns list-topics \
  --region ap-northeast-2 \
  --query "Topics[?contains(TopicArn, 'inspector-alerts')]"
```

이메일 구독 상태를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws sns list-subscriptions-by-topic \
  --topic-arn <SNS_TOPIC_ARN> \
  --region ap-northeast-2 \
  --query 'Subscriptions[*].{Protocol:Protocol,Endpoint:Endpoint,Status:SubscriptionArn}'
```

기대 결과: `SubscriptionArn`이 `PendingConfirmation`이 아닌 실제 ARN으로 표시된다 (이메일 확인 완료 시).

EventBridge → SNS 알림 전달을 테스트 이벤트로 직접 검증한다.

```bash
AWS_PROFILE=<PROFILE> aws events put-events \
  --region ap-northeast-2 \
  --entries '[{
    "Source": "aws.inspector2",
    "DetailType": "Inspector2 Finding",
    "Detail": "{\"severity\":\"CRITICAL\",\"title\":\"[테스트] Critical 취약점 발견\",\"description\":\"EventBridge-SNS 연결 테스트\",\"status\":\"ACTIVE\",\"resources\":[{\"type\":\"AWS_ECR_CONTAINER_IMAGE\",\"details\":{\"awsEcrContainerImage\":{\"imageHash\":\"sha256:test\"}}}]}",
    "EventBusName": "default"
  }]'
```

기대 결과: 명령 실행 후 수 초 내 등록된 이메일로 알림 메일이 수신된다.

**검증 완료 기준**

- EventBridge Rule 상태가 `ENABLED`이다.
- SNS Topic이 생성되어 있다.
- 이메일 구독이 확인 완료(`Confirmed`) 상태이다.
- 테스트 이벤트 (`put-events`) 실행 후 이메일 알림이 정상 수신된다.

---

## Risk 및 미적용 시 영향

- **탐지 지연:** Inspector가 취약점을 발견해도 담당자에게 전달되지 않아 조치가 지연된다. 취약한 이미지가 계속 운영 환경에서 실행된다.
- **우선순위 없는 대응:** findings를 정기적으로 수동 조회하지 않으면 Critical 취약점과 Minor 취약점이 동일하게 방치된다.
- **감사 추적 부재:** 취약점 발견 시점과 조치 시점이 기록되지 않아 보안 감사 시 대응 이력 증명이 어렵다.
- **심각도:** **중간**. **Container Image 스캔 및 차단** 단계에서 탐지는 되지만 관리 프로세스 없이는 실질적인 보안 개선으로 이어지지 않는다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | DevSecOps 또는 플랫폼 담당자 (알림 수신 및 판단) |
| AWS 추가 비용 | EventBridge: 월 100만 건 이벤트까지 무료. SNS: 이메일 알림은 월 1,000건까지 무료 |
| 운영 고려사항 | Inspector findings 알림 초기에는 기존 이미지의 누적 취약점으로 인해 알림이 다량 발생할 수 있다. 초기 일괄 검토 후 판단 기준을 정제하는 작업이 필요하다. |

---

## Assessment 체크리스트

- [ ] EventBridge Rule이 CRITICAL/HIGH Inspector findings를 정상 감지하는가?
- [ ] SNS Topic이 생성되어 있고 이메일 구독이 확인 완료 상태인가?
- [ ] Inspector finding 발생 시 담당자에게 이메일 알림이 수신되는가?
- [ ] 취약점 심각도별 판단 기준과 조치 기한이 문서화되어 있는가?
- [ ] CRITICAL findings에 대한 24시간 내 조치 프로세스가 수립되어 있는가?

---

## 참고 자료

- [Amazon Inspector - EventBridge integration](https://docs.aws.amazon.com/inspector/latest/user/findings-understanding-EventBridge.html)
- [Amazon SNS - Email notifications](https://docs.aws.amazon.com/sns/latest/dg/sns-email-notifications.html)
- [Amazon EventBridge - Event patterns](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **AWS EKS Best Practices**
  Inspector findings를 EventBridge로 연동해 취약점 발견 즉시 알림을 받고, 조치 이력을 관리하도록 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너 이미지 취약점은 발견 후 즉각적인 패치 또는 격리 조치를 취하도록 권고하며, 지속적인 모니터링 프로세스를 요구한다.
