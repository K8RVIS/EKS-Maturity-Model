---
title: "K8s 인증서 수명주기를 자동화한다"
description: "EKS에서 외부 사용자가 애플리케이션에 접근할 때 TLS 인증서는 ALB, NLB, Ingress Controller, CloudFront 같은 진입점에서 서비스 신뢰와 전송 중 데이터 보호를 담당한다. 인증서 자체는 AWS Certificate Manager(ACM)"
phase: "Optimized"
domain: "데이터 보호"
difficulty: "★★☆"
owner: "공통 (전체 실습)"
order: 50
sidebar:
  order: 50
---

## 왜 필요한가

EKS에서 외부 사용자가 애플리케이션에 접근할 때 TLS 인증서는 ALB, NLB, Ingress Controller, CloudFront 같은 진입점에서 서비스 신뢰와 전송 중 데이터 보호를 담당한다. 인증서 자체는 AWS Certificate Manager(ACM)가 자동 갱신할 수 있지만, DNS validation 기반 인증서는 ACM이 요구하는 CNAME record가 public DNS에 계속 유지되어야 한다.

인증서 만료 사고는 애플리케이션 코드 장애가 아니어도 서비스 전체 장애로 보인다. validation CNAME이 수동으로 삭제되거나, 팀별 도메인이 늘면서 누락되거나, 인증서 ARN이 오래된 Ingress annotation에 남아 있으면 갱신 실패와 도메인 불일치가 발생한다. 따라서 인증서 발급, 검증 record 유지, Ingress 연결, 갱신 상태 점검까지 수명주기 전체를 코드로 관리해야 한다.

이 항목의 목표는 다음과 같다.

- ACM DNS validation CNAME을 수동 콘솔 작업이 아니라 Terraform으로 유지한다.
- validation CNAME 삭제가 인증서 자동 갱신 실패로 이어지지 않도록 보호한다.
- 팀별 namespace와 도메인이 늘어도 동일한 구조로 validation record를 관리한다.
- 인증서 상태, 갱신 가능 여부, 실제 HTTPS 응답을 주기적으로 검증한다.

## 수행 방법

**사전 조건**

- 공개 도메인을 소유하고 DNS provider에서 CNAME record를 관리할 수 있어야 한다.
- 예시로서 DNS provider로 Cloudflare를 사용하다. Route 53을 사용하는 환경이라면 `aws_route53_record`로 같은 원칙을 적용한다.
- ACM 인증서와 TLS 종료 지점은 같은 리전에 있어야 한다. ALB가 `ap-northeast-2`에 있으면 ACM 인증서도 `ap-northeast-2`에 있어야 한다.
- Terraform에서 Cloudflare provider를 사용할 수 있도록 API token과 Zone ID가 준비되어야 한다.
- Kubernetes Ingress 또는 Gateway가 어떤 ACM 인증서 ARN을 사용하는지 확인할 수 있어야 한다.

### Step 1: 인증서 수명주기 관리 대상을 분리한다

인증서 자동화는 한 리소스로 끝나지 않는다. 다음 대상을 각각 코드로 관리한다.

| 대상 | 예시 리소스 | 관리 목적 |
| --- | --- | --- |
| ACM 인증서 | `aws_acm_certificate` | 도메인 인증서 발급과 교체 |
| DNS validation CNAME | `cloudflare_record` | ACM 자동 갱신 조건 유지 |
| 인증서 검증 완료 | `aws_acm_certificate_validation` | `ISSUED` 상태 보장 |
| Ingress TLS 연결 | ALB Ingress annotation | HTTPS listener와 인증서 ARN 연결 |
| 애플리케이션 DNS | ExternalDNS 또는 DNS record | 팀 도메인이 ALB를 가리키도록 유지 |
| 모니터링 | EventBridge, CloudWatch, 외부 synthetic check | 만료와 갱신 실패 조기 탐지 |

이 중 DNS validation CNAME 유지에 초점을 둔다. 이는 ACM 자동 갱신의 전제 조건이므로 Optimized 단계의 중요한 기반이다.

### Step 2: Cloudflare provider를 platform 환경에 추가한다

Cloudflare provider를 Terraform required providers에 포함한다.

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.43"
    }
  }
}

provider "cloudflare" {}
```

Cloudflare API token은 Terraform 변수 파일에 평문으로 두지 않는다. 환경변수 또는 안전한 CI/CD secret으로 주입한다.

```bash
export CLOUDFLARE_API_TOKEN="<cloudflare-api-token>"
```

API token 권한은 대상 zone의 DNS record 관리에 필요한 최소 범위로 제한한다.

### Step 3: ACM DNS validation record 변수를 선언한다

Cloudflare zone ID와 ACM validation record 목록을 변수로 받는다.

```hcl
variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID that hosts public ACM DNS validation records. Leave null to skip Cloudflare DNS management."
  type        = string
  default     = null
}

variable "acm_dns_validation_records" {
  description = "ACM DNS validation CNAME records that must remain published for managed renewal."
  type = map(object({
    name    = string
    content = string
  }))
  default = {}

  validation {
    condition     = var.cloudflare_zone_id != null || length(var.acm_dns_validation_records) == 0
    error_message = "cloudflare_zone_id must be set when acm_dns_validation_records is not empty."
  }
}
```

`cloudflare_zone_id`가 없는 상태에서 record만 입력되는 구성을 막아 Terraform plan 단계에서 오류를 내도록 한다.

### Step 4: Validation CNAME을 Terraform으로 유지한다

핵심 리소스는 다음 구조다.

```hcl
locals {
  acm_dns_validation_records = var.cloudflare_zone_id == null ? {} : var.acm_dns_validation_records
}

resource "cloudflare_record" "acm_dns_validation" {
  for_each = local.acm_dns_validation_records

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.name, ".")
  content = trimsuffix(each.value.content, ".")
  type    = "CNAME"
  ttl     = 1
  proxied = false
  comment = "ACM DNS validation record for managed certificate renewal."

  lifecycle {
    prevent_destroy = true
  }
}
```

중요한 설정은 다음과 같다.

- `type = "CNAME"`: ACM DNS validation record는 CNAME이다.
- `proxied = false`: ACM validation CNAME은 Cloudflare proxy를 통과시키지 않고 DNS only로 유지한다.
- `ttl = 1`: Cloudflare의 automatic TTL을 사용한다.
- `trimsuffix(..., ".")`: ACM이 반환하는 FQDN 끝의 점을 provider 입력 형식에 맞춘다.
- `prevent_destroy = true`: 실수로 validation record를 삭제해 자동 갱신 조건이 깨지는 일을 막는다.

### Step 5: team-a 예시를 전체 namespace 패턴으로 확장한다

`terraform.tfvars`는 단일 validation record를 직접 선언한다.

```hcl
cloudflare_zone_id = "<zone-id>"
acm_dns_validation_records = {
  terraform_study_esc_shop = {
    name    = "_f9cf93ba3be5471b7d1ef382ff592f1e"
    content = "_b4982505b75b312208f9a581ff4421f2.jkddzztszm.acm-validations.aws"
  }
}
```

```hcl
acm_dns_validation_records = {
  team_a = {
    name    = "_<token-a>.team-a.terraform-study-esc.shop"
    content = "_<value-a>.acm-validations.aws"
  }
  team_b = {
    name    = "_<token-b>.team-b.terraform-study-esc.shop"
    content = "_<value-b>.acm-validations.aws"
  }
  team_c = {
    name    = "_<token-c>.team-c.terraform-study-esc.shop"
    content = "_<value-c>.acm-validations.aws"
  }
  team_d = {
    name    = "_<token-d>.team-d.terraform-study-esc.shop"
    content = "_<value-d>.acm-validations.aws"
  }
}
```

여러 팀이 같은 wildcard 인증서(`*.terraform-study-esc.shop`)를 공유한다면 validation record는 인증서 단위로 하나만 필요할 수 있다. 반대로 팀별로 별도 인증서를 발급한다면 각 인증서의 `DomainValidationOptions`에 나온 record를 모두 등록해야 한다.

namespace와 도메인 관계는 별도 변수로 표준화한다.

```hcl
variable "team_names" {
  description = "Team namespace names and matching application subdomains."
  type        = list(string)
  default     = ["<namespace_1>", "<namespace_2>", "<namespace_3>", "<namespace_4>"]
}

locals {
  team_domains = {
    for team in var.team_names :
    team => "${team}.terraform-study-esc.shop"
  }
}
```

이 구조를 사용하면 특정 namespace에만 테스트하더라도 문서와 코드의 기본 설계는 모든 namespace를 대상으로 유지할 수 있다.

### Step 6: ACM에서 validation record를 가져오는 흐름을 표준화한다

이미 ACM 인증서가 수동으로 생성된 상태라면 현재 validation record를 먼저 조회한다.

```bash
aws acm describe-certificate \
  --region <region> \
  --certificate-arn <certificate-arn> \
  --query 'Certificate.DomainValidationOptions[].{Domain:DomainName,Name:ResourceRecord.Name,Type:ResourceRecord.Type,Value:ResourceRecord.Value,Status:ValidationStatus}' \
  --output table
```

Terraform으로 ACM 인증서까지 생성한다면 validation record는 `aws_acm_certificate`의 `domain_validation_options`에서 생성한다.

```hcl
resource "aws_acm_certificate" "teams" {
  for_each = local.team_domains

  domain_name       = each.value
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}
```

Cloudflare record와 ACM validation을 연결한다.

```hcl
resource "cloudflare_record" "team_acm_dns_validation" {
  for_each = {
    for item in flatten([
      for team, cert in aws_acm_certificate.teams : [
        for dvo in cert.domain_validation_options : {
          key     = "${team}-${dvo.domain_name}"
          name    = dvo.resource_record_name
          content = dvo.resource_record_value
        }
      ]
    ]) : item.key => item
  }

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.name, ".")
  content = trimsuffix(each.value.content, ".")
  type    = "CNAME"
  ttl     = 1
  proxied = false

  lifecycle {
    prevent_destroy = true
  }
}
```

환경이 아직 단일 인증서를 수동으로 관리한다면 `acm_dns_validation_records`에 record를 입력하는 방식으로 시작하고, 이후 ACM 인증서 생성까지 Terraform으로 흡수한다.

### Step 7: Ingress와 인증서 ARN 연결을 점검한다

ACM validation record가 유지되어도 Ingress가 오래된 인증서 ARN을 참조하면 실제 트래픽은 보호되지 않는다. ALB Ingress annotation을 확인한다.

```yaml
metadata:
  annotations:
    alb.ingress.kubernetes.io/certificate-arn: <acm-certificate-arn>
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
spec:
  ingressClassName: alb
  rules:
    - host: <namespace>.terraform-study-esc.shop
```

모든 namespace에 대해 공통 patch 또는 템플릿을 사용하면 팀별 누락을 줄일 수 있다.

```yaml
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: <namespace>.terraform-study-esc.shop
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"
```

애플리케이션 DNS 레코드는 ExternalDNS로 자동화하고, ACM validation CNAME은 Terraform으로 유지하는 방식이 역할 분리가 명확하다.

### Step 8: prevent_destroy 운영 절차를 정한다

`prevent_destroy = true`는 실수 방지에 유용하지만, 인증서를 의도적으로 교체하거나 도메인을 폐기할 때 Terraform destroy를 막을 수 있다. 운영 절차를 미리 정한다.

1. 새 인증서를 발급하고 새 validation CNAME을 먼저 배포한다.
2. ACM 인증서가 `ISSUED`가 될 때까지 기다린다.
3. Ingress 또는 Listener가 새 인증서 ARN을 사용하도록 교체한다.
4. 실제 HTTPS 접속과 인증서 체인을 검증한다.
5. 이전 인증서가 더 이상 사용되지 않는지 `InUseBy`를 확인한다.
6. 이전 validation CNAME 제거가 필요한 경우 별도 승인 후 lifecycle 설정을 임시 조정한다.

validation record 삭제는 인증서 자동 갱신 조건에 영향을 줄 수 있으므로 일반적인 cleanup 작업에 섞지 않는다.

## 검증 방법

Terraform plan에서 Cloudflare validation record가 생성 또는 유지되는지 확인한다.

```bash
terraform plan
```

기대 결과:

- `cloudflare_record.acm_dns_validation` 리소스가 의도한 CNAME을 관리한다.
- `proxied = false`다.
- 실수로 삭제되는 변경이 있다면 `prevent_destroy`로 plan/apply가 차단된다.

Terraform output으로 관리 중인 validation record 이름을 확인한다.

```bash
terraform output acm_dns_validation_record_names
```

기대 결과:

- Terraform이 관리하는 ACM validation CNAME 이름이 출력된다.
- 적용 대상 전체 인증서 또는 전체 팀 도메인의 record가 포함된다.

ACM 인증서 상태를 확인한다.

```bash
aws acm describe-certificate \
  --region <region> \
  --certificate-arn <certificate-arn> \
  --query 'Certificate.{Domain:DomainName,Status:Status,RenewalEligibility:RenewalEligibility,NotAfter:NotAfter,InUseBy:InUseBy}' \
  --output json
```

기대 결과:

- `Status`가 `ISSUED`다.
- `RenewalEligibility`가 `ELIGIBLE`이다.
- `InUseBy`에 ALB listener 같은 실제 사용 리소스가 포함된다.
- `NotAfter`가 만료 임박 상태가 아니다.

DNS validation CNAME이 public DNS에서 조회되는지 확인한다.

```bash
dig +short CNAME _<validation-token>.<domain>
```

기대 결과:

- ACM이 제공한 `*.acm-validations.aws` 대상이 반환된다.
- Cloudflare proxy가 적용되지 않은 DNS only record다.

모든 namespace의 HTTPS endpoint를 반복 확인한다.

```bash
for ns in team-a team-b team-c team-d; do
  host="${ns}.terraform-study-esc.shop"
  echo "== ${host} =="
  curl -I --max-time 10 "https://${host}"
done
```

기대 결과:

- 각 namespace 도메인이 HTTPS로 정상 응답한다.
- 인증서 오류가 발생하지 않는다.

인증서 subject, issuer, 만료일을 확인한다.

```bash
openssl s_client \
  -connect <domain>:443 \
  -servername <domain> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

기대 결과:

- 인증서 SAN이 접속한 도메인을 포함한다.
- issuer가 신뢰 가능한 공개 CA다.
- 만료일이 운영 기준보다 충분히 남아 있다.

ALB listener에 인증서가 연결되어 있는지 확인한다.

```bash
aws elbv2 describe-listeners \
  --region <region> \
  --load-balancer-arn <load-balancer-arn> \
  --query 'Listeners[].{Port:Port,Protocol:Protocol,SslPolicy:SslPolicy,Certificates:Certificates[].CertificateArn}' \
  --output table
```

기대 결과:

- 443 listener가 존재한다.
- 의도한 ACM certificate ARN이 연결되어 있다.
- TLS policy가 조직 기준에 맞는다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 인증서가 만료되어 사용자가 보안 경고를 무시하게 되고, 공격자가 유사 도메인 또는 중간자 공격으로 자격 증명을 탈취한다.
- **운영 장애:** validation CNAME이 삭제되면 ACM 자동 갱신이 실패할 수 있고, 만료 시점에 외부 서비스가 접속 불가 상태가 된다.
- **데이터 보호 실패:** HTTP 예외 경로, 오래된 TLS 정책, 잘못된 인증서 ARN이 남으면 로그인 정보, 세션 쿠키, API token이 전송 중 노출될 수 있다.
- **감사 리스크:** 콘솔에서 수동으로 DNS validation record를 수정하면 변경 이력과 승인 흐름이 Terraform에 남지 않는다.
- **복구 리스크:** 인증서 만료 후 복구는 DNS 전파, ACM validation, ALB listener 갱신이 모두 필요해 즉시 해결되지 않을 수 있다.
- **심각도:** **높음**. 외부 진입점 인증서 문제는 데이터 보호와 서비스 가용성에 동시에 영향을 준다.

## 발생 비용

- **AWS 비용 발생 여부 및 예상 규모:** 퍼블릭 ACM 인증서 자체는 무료다. ALB, CloudWatch, EventBridge, SNS, 외부 모니터링 비용은 별도로 발생할 수 있다.
- **Cloudflare 비용:** DNS record 관리와 API token 사용은 일반적으로 추가 비용 없이 가능하다. WAF, proxy, advanced certificate 기능은 플랜에 따라 비용이 달라질 수 있다.
- **운영 비용:** 인증서와 DNS record를 Terraform state로 관리하므로 state 보호, provider token 관리, lifecycle 예외 처리 절차가 필요하다.
- **확장 비용:** namespace별 인증서를 각각 발급하면 record 수와 검증 대상이 늘어난다. wildcard 인증서를 사용하면 운영은 단순해지지만 blast radius와 교체 절차를 별도로 검토해야 한다.
- **대안 비용:** cert-manager + ACME를 사용하면 Kubernetes 내부에서 자동화할 수 있지만 ACME rate limit, issuer Secret 보호, HTTP-01/DNS-01 challenge 운영이 필요하다.

## 참고 자료

- [AWS Certificate Manager DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [AWS Certificate Manager managed renewal](https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html)
- [Renewal for domains validated by DNS](https://docs.aws.amazon.com/acm/latest/userguide/dns-renewal-validation.html)
- [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [Cloudflare DNS records](https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/)
- [AWS Load Balancer Controller Ingress annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/)
- [ExternalDNS Cloudflare tutorial](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  외부 서비스 노출, Ingress TLS, 안전한 통신 구성 원칙과 연결된다.
- **[NIST SP 800-53 Rev.5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)**
  `SC-8`, `SC-12`, `SC-13`, `CM-2`와 연결된다.
- **[CIS Controls v8](https://www.cisecurity.org/controls/v8)**
  `3.10 Encrypt Sensitive Data in Transit`와 연결된다.
- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  전송 중 데이터 보호, 인증서 수명주기 자동화, 변경 관리와 연결된다.
- **[AWS Well-Architected Framework - Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)**
  외부 의존성 자동화, 장애 예방, 운영 준비성과 연결된다.

## 적용 시 체크리스트

- [ ] ACM 인증서가 DNS validation 방식으로 발급되었는가?
- [ ] ACM DNS validation CNAME이 Cloudflare 또는 DNS provider에서 Terraform으로 관리되는가?
- [ ] validation CNAME에 `proxied = false` 또는 DNS only 설정이 적용되어 있는가?
- [ ] validation CNAME에 `prevent_destroy = true` 같은 삭제 방지 장치가 있는가?
- [ ] 모든 namespace 또는 모든 팀 도메인의 validation record가 관리 대상에 포함되어 있는가?
- [ ] 인증서와 ALB listener가 같은 AWS 리전에 있는가?
- [ ] Ingress 또는 Listener가 최신 ACM certificate ARN을 사용하고 있는가?
- [ ] HTTP listener가 HTTPS로 redirect하도록 구성되어 있는가?
- [ ] TLS policy가 TLS 1.2 이상을 허용하는 조직 기준에 맞는가?
- [ ] `aws acm describe-certificate`에서 `Status=ISSUED`, `RenewalEligibility=ELIGIBLE`을 확인했는가?
- [ ] 각 namespace 도메인의 HTTPS 접속과 인증서 만료일을 주기적으로 검증하는가?
- [ ] 인증서 교체 또는 도메인 폐기 시 `prevent_destroy` 예외 절차가 문서화되어 있는가?

