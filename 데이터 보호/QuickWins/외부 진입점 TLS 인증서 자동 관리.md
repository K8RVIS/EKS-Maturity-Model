# 외부 진입점 TLS 인증서를 자동 관리한다

> **Phase:** Quick Wins
>
> **보안 영역:** 데이터 보호
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

## 왜 필요한가

EKS에서 외부 사용자가 애플리케이션에 접근할 때 트래픽은 보통 ALB, NLB, CloudFront, API Gateway, Ingress Controller 같은 외부 진입점을 먼저 지난다. 이 구간에서 인증서 발급과 갱신이 불안정하면 애플리케이션 자체가 정상이어도 사용자는 브라우저 경고, API 호출 실패, 모바일 앱 장애를 경험한다.

수동 인증서 운영은 작은 실수 하나가 바로 장애로 이어진다. 만료일을 놓치거나, 잘못된 리전에 인증서를 발급하거나, ALB listener에 이전 인증서 ARN을 계속 연결하거나, DNS 검증 CNAME을 정리하면서 자동 갱신 조건을 깨뜨릴 수 있다. 특히 여러 팀이 각자 Ingress를 만들고 외부 도메인을 붙이는 환경에서는 수동 콘솔 작업이 반복될수록 인증서 만료, 도메인 불일치, 소유권 검증 실패가 누적된다.

따라서 외부 진입점 TLS 인증서는 다음 원칙으로 관리한다.

- 공개 인증서는 ACM에서 DNS 검증 방식으로 발급한다.
- ACM DNS validation CNAME은 삭제하지 않고 IaC로 유지한다.
- ALB, CloudFront 등 TLS 종료 지점에 인증서 ARN을 코드로 연결한다.
- Ingress가 만드는 애플리케이션 DNS 레코드는 ExternalDNS로 자동 동기화한다.
- 인증서 만료, 갱신 실패, DNS drift를 검증 가능한 상태로 만든다.

현재 `eks-vulnerable-infra` 실습에서는 `<domain>`을 AWS Load Balancer Controller 기반 ALB로 노출하고, ACM 인증서를 Ingress annotation으로 연결한 상태다. <br>
`eks-vulnerable-infra/manifests/overlays/<namespace>/web-ingress-patch.yaml`은 아래와 같다.

```yaml
metadata:
  annotations:
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<region>:<account-id>:certificate/<certificate>
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
spec:
  ingressClassName: alb
  rules:
    - host: <domain>
```

이 구성은 외부 진입점 TLS 적용에는 적절하다. 다만 Cloudflare DNS 레코드가 아직 수동 CNAME이면 ALB가 교체되거나 새로운 팀 도메인이 추가될 때 사람이 DNS를 직접 수정해야 한다. <br>
ExternalDNS + Cloudflare 자동화를 통해 수동 DNS 연결을 제거하여 인증서 운영의 안정성을 높일 수 있다.

## 수행 방법

**사전 조건**

- 외부 공개 도메인을 소유하고 있고 DNS 레코드를 수정할 수 있어야 한다.
- Cloudflare를 authoritative DNS로 사용한다면 Zone ID와 DNS 편집 권한이 있는 API Token이 필요하다.
- ACM 인증서와 ALB는 같은 AWS 리전에 있어야 한다. 예: `ap-northeast-2` ALB에는 `ap-northeast-2` ACM 인증서를 연결한다.
- AWS Load Balancer Controller가 설치되어 있고 `alb` IngressClass가 준비되어 있어야 한다.
- Terraform 또는 GitOps로 Ingress, Helm release, IAM, DNS 설정을 추적할 수 있어야 한다.

### **Step 1: 자동화 범위를 분리한다**


| 영역 | 권장 도구 | 관리 대상 | 설명 |
| --- | --- | --- | --- |
| 인증서 발급 | ACM + Terraform | `aws_acm_certificate` | 공개 인증서를 DNS validation으로 발급한다. |
| 도메인 소유권 검증 | Terraform + Cloudflare provider | ACM validation CNAME | ACM이 자동 갱신할 수 있도록 CNAME을 유지한다. |
| TLS 종료 연결 | AWS Load Balancer Controller | ALB HTTPS listener | Ingress annotation으로 ACM ARN, TLS policy, redirect를 선언한다. |
| 애플리케이션 DNS | ExternalDNS + Cloudflare | 서비스 도메인 CNAME/A record | Ingress host를 ALB DNS name으로 자동 연결한다. |
| 갱신 실패 감지 | EventBridge, AWS Health, 모니터링 | 만료 이벤트 | ACM 자동 갱신 실패나 만료 임박을 알림으로 받는다. |

ExternalDNS는 Ingress나 Service를 보고 `<domain>` 같은 애플리케이션 DNS 레코드를 생성한다. 반면 ACM DNS validation CNAME은 Kubernetes 리소스에서 파생되지 않으므로 Terraform의 Cloudflare provider로 별도 관리하는 편이 명확하다.

### **Step 2: ACM 인증서를 DNS 검증 방식으로 발급한다**

새 인증서를 발급할 때는 이메일 검증보다 DNS 검증을 우선한다. DNS 검증 CNAME이 유지되고 인증서가 ACM 연동 AWS 서비스에 연결되어 있으면 ACM이 갱신을 자동 처리할 수 있다.

```bash
export AWS_REGION=<region>
export DOMAIN_NAME=<domain>

aws acm request-certificate \
  --region "${AWS_REGION}" \
  --domain-name "${DOMAIN_NAME}" \
  --validation-method DNS \
  --idempotency-token <token>
```

발급 후 ACM이 요구하는 DNS validation record를 확인한다.

```bash
aws acm describe-certificate \
  --region "${AWS_REGION}" \
  --certificate-arn "${CERTIFICATE_ARN}" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' \
  --output table
```

Terraform으로 관리한다면 인증서와 검증 레코드를 같은 변경 흐름에 포함한다.

```hcl
resource "aws_acm_certificate" "<namespace>" {
  domain_name       = "<domain>"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}
```

Cloudflare DNS 레코드는 사용하는 provider 버전에 맞는 리소스로 생성한다. 핵심은 ACM이 제공한 `name`, `type`, `value`를 그대로 보존하고, proxy를 켜지 않는 것이다.

```hcl
locals {
  <namespace>_acm_validation_records = {
    for dvo in aws_acm_certificate.<namespace>.domain_validation_options :
    dvo.domain_name => {
      name    = dvo.resource_record_name
      type    = dvo.resource_record_type
      content = dvo.resource_record_value
    }
  }
}

resource "cloudflare_dns_record" "<namespace>_acm_validation" {
  for_each = local.<namespace>_acm_validation_records

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  ttl     = 1
  proxied = false
}
```

인증서 검증 완료까지 Terraform에서 대기시키면 ALB 연결 시점에 `PENDING_VALIDATION` 인증서를 참조하는 실수를 줄일 수 있다.

```hcl
resource "aws_acm_certificate_validation" "<namespace>" {
  certificate_arn         = aws_acm_certificate.<namespace>.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.<namespace>_acm_validation : record.name]
}
```

### **Step 3: ALB Ingress에 ACM 인증서와 TLS 정책을 연결한다**

AWS Load Balancer Controller를 사용하는 워크로드는 Ingress annotation으로 HTTPS listener, 인증서 ARN, HTTP to HTTPS redirect, TLS policy를 선언한다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  namespace: team-d
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:<region>:<account-id>:certificate/<certificate>
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
spec:
  ingressClassName: alb
  rules:
    - host: <domain>
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

인증서 ARN은 장기적으로 하드코딩보다 Terraform output, Helm values, Kustomize patch, GitOps 환경 값 중 하나로 주입하는 편이 좋다. 단일 실습에서는 명시적인 patch가 이해하기 쉽고, 여러 팀으로 확장될 때는 도메인과 인증서 ARN 매핑을 모듈화한다.

### **Step 4: ExternalDNS + Cloudflare로 애플리케이션 DNS를 자동화한다**

Cloudflare에서 수동으로 아래 레코드를 만드는 대신 ExternalDNS가 Ingress 상태를 보고 자동 생성하게 한다.

```text
Type: CNAME
Name: <namespace>
Target: <target>
Proxy status: DNS only
TTL: Auto
```

Cloudflare API Token은 최소 권한으로 만든다.

- Zone: `<domain>`
- Permission: `Zone Read`
- Permission: `DNS Edit`

초기 검증 단계에서는 Cloudflare proxy를 끄고 DNS only로 운영한다. Cloudflare proxy를 켜면 클라이언트 TLS 종료 지점이 Cloudflare가 되고, Cloudflare와 ALB 사이의 origin TLS 설정도 함께 검토해야 한다. 이 문서의 기본 범위는 ALB + ACM을 원본 TLS 종료 지점으로 검증하는 것이므로 `proxied: false`를 우선한다.

ExternalDNS Helm values 예시는 다음과 같다.

```yaml
provider:
  name: cloudflare

sources:
  - ingress

domainFilters:
  - <domain>

policy: sync
registry: txt
txtOwnerId: eks-vulnerable-infra-dev

env:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: external-dns-cloudflare
        key: api-token

extraArgs:
  - --cloudflare-proxied=false
```

Ingress에는 ExternalDNS가 명확히 해석할 수 있는 hostname과 Cloudflare proxy 정책을 붙인다. `spec.rules[].host`만으로도 동작할 수 있지만, annotation을 같이 두면 자동화 의도를 더 잘 파악할 수 있다.<br>
위의 예시에서 `policy: sync`는 초기 도입 단계에서는 위험할 수도 있다. 따라서 만약 수동 Cloudflare 레코드가 이미 있는 환경이면 처음에는 `policy: upsert-only` 또는 `--dry-run`으로 충돌을 확인하고, TXT ownership record를 붙인 뒤 `sync`로 전환하는 순서를 권장한다.

```yaml
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: <domain>
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"
```

ExternalDNS는 DNS 레코드를 소유권 TXT record와 함께 관리한다. `txtOwnerId`는 같은 Cloudflare zone을 여러 클러스터나 여러 ExternalDNS 인스턴스가 공유할 때 충돌을 줄이는 식별자이므로, 클러스터와 환경을 구분할 수 있게 정한다.

### **Step 5: 인증서 갱신 조건과 알림을 유지한다**

ACM 관리형 인증서가 자동 갱신되려면 다음 조건을 계속 만족해야 한다.

- 인증서가 ALB, CloudFront, API Gateway 같은 ACM 연동 AWS 서비스에 연결되어 있다.
- DNS validation CNAME이 public DNS에서 계속 조회된다.
- 인증서의 모든 SAN에 필요한 validation record가 남아 있다.
- 인증서와 TLS 종료 서비스의 리전 요구사항이 맞다.

갱신 실패는 장애 직전에야 발견하면 늦다. EventBridge에서 ACM certificate approaching expiration 또는 renewal failure 이벤트를 받아 SNS, Slack, PagerDuty 같은 운영 채널로 알린다. 외부 모니터링에서는 실제 도메인의 인증서 만료일도 함께 확인한다.

### **Step 6: 현재 실습 환경에 적용할 권장 순서**

`<domain>` 기준으로는 이미 ALB + ACM TLS 연결이 검증되어 있으므로 다음 순서가 적절하다.

1. 현재 ACM 인증서의 DNS validation CNAME이 Cloudflare에 남아 있는지 확인한다.
2. ACM 인증서와 validation CNAME을 Terraform으로 관리할지 결정한다.
3. ExternalDNS용 Cloudflare API Token과 Kubernetes Secret을 준비한다.
4. ExternalDNS Helm release를 Terraform 관리 대상으로 추가한다.
5. `<namespace>` Ingress에 ExternalDNS annotation을 추가한다.
6. 수동 Cloudflare CNAME과 ExternalDNS가 만들 레코드가 충돌하지 않도록 소유권을 정리한다.
7. DNS only 상태에서 HTTP redirect, HTTPS 200, 인증서 체인, ALB listener를 다시 검증한다.

## 검증 방법

먼저 ACM 인증서가 발급 완료 상태인지 확인한다.

```bash
aws acm describe-certificate \
  --region <region> \
  --certificate-arn arn:aws:acm:<region>:<account-id>:certificate/<certificate> \
  --query 'Certificate.{Domain:DomainName,Status:Status,RenewalEligibility:RenewalEligibility,NotAfter:NotAfter,InUseBy:InUseBy}' \
  --output json
```

기대 결과:

- `Status`가 `ISSUED`다.
- `RenewalEligibility`가 `ELIGIBLE`이다.
- `InUseBy`에 ALB listener 또는 관련 AWS 리소스가 포함된다.
- `NotAfter`가 만료 임박 상태가 아니다.

ACM DNS validation CNAME이 public DNS에서 조회되는지 확인한다.

```bash
dig +short CNAME _<acm-validation-token>.<domain>
```

기대 결과는 ACM이 요구한 `*.acm-validations.aws` 대상이 반환되는 것이다.

ALB listener에 올바른 인증서와 TLS 정책이 연결되어 있는지 확인한다.

```bash
aws elbv2 describe-listeners \
  --region <region> \
  --load-balancer-arn "${LOAD_BALANCER_ARN}" \
  --query 'Listeners[].{Port:Port,Protocol:Protocol,SslPolicy:SslPolicy,Actions:DefaultActions[].Type,Certificates:Certificates[].CertificateArn}' \
  --output table
```

기대 결과:

- 80/HTTP listener의 기본 동작이 `redirect`다.
- 443/HTTPS listener에 ACM certificate ARN이 연결되어 있다.
- TLS policy가 TLS 1.2 이상을 허용하는 정책이다.

ExternalDNS가 Cloudflare 레코드를 만들었는지 확인한다.

```bash
kubectl logs -n external-dns deploy/external-dns

dig +short CNAME <domain>
```

기대 결과:
-  `<domain>`이 ALB DNS name을 가리키는 것이다.

Cloudflare API로도 확인할 수 있다.

```bash
curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=<domain>" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json"
```
기대 결과:

- `type`이 `CNAME` 또는 ExternalDNS 설정에 맞는 레코드 타입이다.
- `content`가 ALB DNS name이다.
- `proxied`가 초기 검증 기준으로 `false`다.
- ExternalDNS TXT registry record가 함께 존재한다.

클라이언트 관점의 TLS 동작도 확인한다.

```bash
curl -I http://<domain>
curl -I https://<domain>

openssl s_client \
  -connect <domain>:443 \
  -servername <domain> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

기대 결과:

- HTTP 요청은 HTTPS로 301 또는 302 redirect된다.
- HTTPS 요청은 정상 응답을 반환한다.
- 인증서 subject 또는 SAN이 `<domain>`과 일치한다.
- 인증서 issuer가 신뢰 가능한 공개 CA이며 만료일이 충분히 남아 있다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 만료된 인증서나 잘못된 도메인 인증서가 배포되어 사용자가 보안 경고를 무시하도록 유도되고, 공격자가 유사 도메인이나 프록시를 통해 자격 증명 탈취를 시도한다.
- **운영 장애:** 인증서 만료, DNS validation CNAME 삭제, ALB 교체 후 CNAME 미수정으로 외부 서비스가 즉시 접속 불가 상태가 될 수 있다.
- **데이터 보호 실패:** HTTP 예외 경로가 남거나 약한 TLS 정책이 유지되면 로그인 정보, 세션 쿠키, API 토큰, 개인정보가 전송 중 노출될 수 있다.
- **감사 추적 실패:** 콘솔에서 수동으로 인증서와 DNS를 수정하면 어떤 변경이 어떤 서비스에 영향을 줬는지 추적하기 어렵다.
- **확장성 저하:** 팀별 Ingress가 늘어날수록 수동 DNS 연결과 인증서 ARN 관리가 반복되어 실수 가능성이 커진다.
- **심각도:** **높음**. 외부 진입점 인증서 문제는 사용자 신뢰, 데이터 보호, 서비스 가용성에 동시에 영향을 준다.

## 인적 리소스 및 비용

- **담당자 및 예상 소요 시간:** 플랫폼 엔지니어 1명 기준으로 ACM 발급과 DNS validation 자동화 1~2시간, ExternalDNS + Cloudflare 연동 1~2시간, 검증과 문서화 1시간 내외
- **AWS 비용 발생 여부 및 예상 규모:** 퍼블릭 ACM 인증서 자체는 무료다. ALB 사용료, LCU, CloudWatch/EventBridge/SNS 알림 비용은 별도로 발생할 수 있다.
- **Cloudflare 비용:** DNS 레코드 관리와 API Token 사용은 일반적으로 추가 비용 없이 가능하다. 단, Cloudflare proxy, WAF, regional services, advanced certificate 기능은 플랜에 따라 비용이나 권한 제약이 생길 수 있다.
- **운영 비용:** ExternalDNS를 클러스터 애드온으로 운영해야 하므로 Helm release, Kubernetes Secret, RBAC, 로그 모니터링 관리가 필요하다.
- **대안 비용:** cert-manager + Let's Encrypt 방식은 오픈소스로 가능하지만 ACME challenge, rate limit, Kubernetes TLS Secret 보호를 별도로 운영해야 한다. ACM Private CA는 강력하지만 월별 CA 비용과 인증서 발급 비용이 발생한다.

## 참고 자료

- [AWS Certificate Manager DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [Renewal for domains validated by DNS - AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/dns-renewal-validation.html)
- [Managed certificate renewal in AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html)
- [AWS Load Balancer Controller Ingress annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/)
- [ExternalDNS annotations](https://kubernetes-sigs.github.io/external-dns/latest/docs/annotations/annotations/)
- [ExternalDNS Cloudflare tutorial](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/)
- [Cloudflare Create DNS Record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **Kubernetes Security Checklist**
  외부로 노출되는 서비스의 안전한 통신 구성, Ingress 관리, 서비스 노출 최소화 원칙과 연결된다.
- **NIST SP 800-53 Rev.5**
  `SC-8` 전송 기밀성 및 무결성 보호, `SC-13` 암호기술 사용과 연결된다.
- **CIS Controls v8**
  `3.10 Encrypt Sensitive Data in Transit`와 연결된다.
- **AWS Well-Architected Framework - Security Pillar**
  전송 중 데이터 보호, 인증서 수명주기 관리, 자동화된 보안 운영 원칙과 연결된다.

## Assessment 체크리스트

- [ ] 외부 공개 도메인의 TLS 인증서가 ACM에서 관리되는가?
- [ ] ACM 인증서가 DNS validation 방식으로 발급되었는가?
- [ ] ACM validation CNAME이 Cloudflare 또는 DNS provider에 IaC로 유지되는가?
- [ ] 인증서와 ALB listener가 같은 AWS 리전에 있는가?
- [ ] ALB HTTPS listener에 올바른 ACM certificate ARN이 연결되어 있는가?
- [ ] HTTP listener가 HTTPS로 redirect하도록 설정되어 있는가?
- [ ] TLS policy가 TLS 1.2 이상을 강제하는가?
- [ ] ExternalDNS가 Ingress host를 Cloudflare DNS record로 자동 동기화하는가?
- [ ] Cloudflare record가 초기 검증 기준으로 DNS only 또는 의도한 proxy 정책을 따르는가?
- [ ] ExternalDNS가 TXT registry와 고유 `txtOwnerId`로 레코드 소유권을 관리하는가?
- [ ] 인증서 만료 또는 갱신 실패 알림이 운영 채널로 전달되는가?
- [ ] 인증서 갱신 후에도 ALB listener와 실제 도메인 접속이 자동으로 정상 유지되는지 검증했는가?
