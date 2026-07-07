---
title: "Container Image 취약점을 관리한다"
description: "**Container Image 스캔 및 차단**(ECR 향상된 스캔 + Inspector CONTINUOUS_SCAN)은 취약점을 자동으로 탐지하지만, 발견된 모든 CVE가 실제 운영 환경에서 exploit 가능한 위협은 아니다."
phase: "Foundational"
domain: "Pod 보안"
difficulty: "★★☆"
owner: "장해윤"
order: 80
sidebar:
  order: 80
---

## 왜 필요한가

**Container Image 스캔 및 차단**(ECR 향상된 스캔 + Inspector CONTINUOUS_SCAN)은 취약점을 자동으로 탐지하지만, 발견된 모든 CVE가 실제 운영 환경에서 exploit 가능한 위협은 아니다.

예를 들어 nginx 이미지에서 PHP 취약점이, Redis 이미지에서 Node.js 취약점이 검출되는 것처럼 해당 서비스가 실제로 실행하지 않는 패키지의 취약점까지 함께 올라온다. 이 노이즈는 관련 없는 CRITICAL 알림이 쌓이면서 진짜 위협을 놓치게 만들고, 수십 개의 CRITICAL 중 실제로 대응해야 할 것이 무엇인지 판단하기 어렵게 한다.

이 단계에서는 서비스 런타임과 무관한 취약점을 자동으로 억제(suppress)하여 진짜 위협만 Inspector 활성 목록에 남기는 **트리아지** 프로세스를 구성한다.

> **트리아지(Triage):** 의료에서 온 개념으로, Inspector가 탐지한 취약점 중 현재 서비스에 실제로 영향 있는 것만 골라내는 행위다.

---

## 수행 방법

**사전 조건**

- **Container Image 스캔 및 차단**(Inspector v2 + ECR 향상된 스캔)이 활성화되어 있어야 한다.

### Step 1: 현재 활성 취약점을 파악한다

Inspector에서 현재 활성화된 CRITICAL/HIGH 취약점을 조회해 서비스 런타임과 무관한 패키지가 얼마나 포함되어 있는지 파악한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "ecrImageRepositoryName": [{"comparison":"PREFIX","value":"eks-secure-infra/"}],
    "findingStatus": [{"comparison":"EQUALS","value":"ACTIVE"}]
  }' \
  --region ap-northeast-2 \
  --query 'findings[].{severity:severity,title:title,pkg:packageVulnerabilityDetails.vulnerablePackages[0].name}' \
  --output table
```

예시 출력 — 트리아지 전에는 서비스 런타임과 무관한 패키지 CVE가 CRITICAL로 함께 표시된다.

```
CRITICAL  CVE-2024-XXXX  php8.1      ← nginx 이미지인데 PHP 취약점
CRITICAL  CVE-2024-YYYY  libssl3     ← nginx가 실제로 사용하는 라이브러리
HIGH      CVE-2024-ZZZZ  python3.11  ← nginx 이미지인데 Python 취약점
```

### Step 2: 서비스별 억제 필터를 구성한다

`aws_inspector2_filter` 리소스를 서비스(레포)별로 생성한다. `action = "SUPPRESS"` 로 설정하면 조건에 매칭되는 취약점은 Inspector 활성 목록에서 숨겨진다. 억제된 findings는 삭제되지 않고 Inspector 콘솔에서 언제든 다시 확인할 수 있다.

```hcl
resource "aws_inspector2_filter" "triage" {
  for_each = var.triage_suppressions

  name        = "${var.project_name}-triage-${each.key}"
  action      = "SUPPRESS"
  description = each.value.reason

  filter_criteria {
    ecr_image_repository_name {
      comparison = "EQUALS"
      value      = "${var.project_name}/${each.key}"
    }

    dynamic "vulnerable_packages" {
      for_each = each.value.package_names
      content {
        name {
          comparison = "PREFIX"
          value      = vulnerable_packages.value
        }
      }
    }
  }
}
```

서비스별 기본 억제 규칙은 다음과 같이 정의한다.

| 서비스 | 런타임 | 억제 대상 패키지 |
|--------|--------|-----------------|
| web | nginx (C) | php, python, java, node, npm, ruby, perl, composer |
| api | echo-server (Go) | php, java, python, ruby, perl, composer, gradle, maven |
| db | Redis (C) | php, java, python, node, npm, ruby, perl, composer |

### Step 3: 취약점 판단 기준을 수립한다

억제 후 ACTIVE 상태로 남은 취약점에 대해 다음 기준으로 실제 환경 영향도를 판단하고 조치 우선순위를 결정한다.

| 심각도 | CVSS 점수 | 판단 기준 | 권고 조치 기한 | 근거 |
|--------|-----------|-----------|---------------|------|
| CRITICAL | 9.0 – 10.0 | 인증 없는 원격 코드 실행 가능, 외부 노출 여부 | 15일 이내 (KEV 등재 시 즉시) | CISA BOD 19-02, BOD 22-01 |
| HIGH | 7.0 – 8.9 | 네트워크 접근 가능성, 실제 사용 컴포넌트 여부 | 30일 이내 | CISA BOD 19-02, NIST SP 800-40 Rev 4 |
| MEDIUM | 4.0 – 6.9 | 내부 접근 경로 존재 여부 | 90일 이내 (정기 패치 주기에 포함) | NIST SP 800-40 Rev 4 |

> **참고:** 위 기한은 CISA BOD 19-02 및 NIST SP 800-40 Rev 4를 기반으로 한 일반 권고치다.
> CISA KEV(Known Exploited Vulnerabilities) Catalog에 등재된 취약점은 심각도와 무관하게 14일 이내 조치를 권고한다.
>
> - [CISA BOD 19-02](https://www.cisa.gov/news-events/directives/bod-19-02-vulnerability-remediation-requirements-internet-accessible-systems)
> - [CISA BOD 22-01 + KEV Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
> - [NIST SP 800-40 Rev 4](https://csrc.nist.gov/pubs/sp/800/40/r4/final)

---

## 검증 방법

### Step 1: 억제 필터 생성 확인

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-filters \
  --action SUPPRESS \
  --region ap-northeast-2 \
  --query 'filters[?starts_with(name, `eks-secure-infra-triage`)].{name:name,arn:arn}' \
  --output table
```

기대 결과: 서비스별 필터 3개가 생성되어 있다.

```
eks-secure-infra-triage-web   arn:aws:inspector2:ap-northeast-2:...
eks-secure-infra-triage-api   arn:aws:inspector2:ap-northeast-2:...
eks-secure-infra-triage-db    arn:aws:inspector2:ap-northeast-2:...
```

### Step 2: 트리아지 후 ACTIVE findings 재확인

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "ecrImageRepositoryName": [{"comparison":"PREFIX","value":"eks-secure-infra/"}],
    "findingStatus": [{"comparison":"EQUALS","value":"ACTIVE"}]
  }' \
  --region ap-northeast-2 \
  --query 'findings[].{severity:severity,pkg:packageVulnerabilityDetails.vulnerablePackages[0].name}' \
  --output table
```

기대 결과: 서비스 런타임과 관련 있는 취약점만 ACTIVE로 남는다.

```
CRITICAL  libssl3   ← nginx가 실제로 링크하는 라이브러리
```

### Step 3: 억제된 findings 보관 확인

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "ecrImageRepositoryName": [{"comparison":"PREFIX","value":"eks-secure-infra/"}],
    "findingStatus": [{"comparison":"EQUALS","value":"SUPPRESSED"}]
  }' \
  --region ap-northeast-2 \
  --query 'findings[].{severity:severity,pkg:packageVulnerabilityDetails.vulnerablePackages[0].name}' \
  --output table
```

기대 결과: PHP, Python 등 억제 대상 패키지들이 SUPPRESSED 상태로 보관되어 있다. 삭제된 것이 아니므로 언제든 재확인 가능하다.

**검증 완료 기준**

- 서비스별 SUPPRESS 필터 3개가 생성되어 있다.
- ACTIVE findings에서 서비스 런타임과 무관한 패키지 취약점이 제거되어 있다.
- SUPPRESSED findings에서 억제 대상 패키지들이 보관되어 있다.
- 취약점 심각도별 판단 기준과 조치 기한이 문서화되어 있다.

---

## Risk 및 미적용 시 영향

- **알람 피로(Alert Fatigue):** 탐지된 모든 CVE를 그대로 노출하면 서비스와 무관한 CRITICAL이 쌓여 진짜 위협을 놓치게 된다.
- **우선순위 없는 대응:** 수십 개의 CRITICAL 중 실제로 대응해야 할 것이 무엇인지 판단하기 어렵고, 조치가 지연된다.
- **감사 추적 부재:** 취약점 발견 시점과 조치 시점이 기록되지 않아 보안 감사 시 대응 이력 증명이 어렵다.
- **심각도:** **중간**. **Container Image 스캔 및 차단** 단계에서 탐지는 되지만 트리아지 없이는 실질적인 보안 개선으로 이어지지 않는다.

---

## 발생 비용

| 항목 | 내용 |
|------|------|
| 담당자 | DevSecOps 또는 플랫폼 담당자 (필터 규칙 정의 및 유지) |
| AWS 추가 비용 | Inspector filter: 추가 비용 없음 |
| 운영 고려사항 | 서비스 런타임이 변경되는 경우 (예: Go → Python 마이그레이션) 억제 규칙을 갱신해야 한다. 억제된 findings는 정기적으로 검토하여 규칙의 유효성을 확인한다. |

---

## 참고 자료

- [Amazon Inspector - Suppression rules](https://docs.aws.amazon.com/inspector/latest/user/findings-suppression.html)
- [Amazon Inspector - Understanding findings](https://docs.aws.amazon.com/inspector/latest/user/findings-understanding.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **AWS EKS Best Practices**
  Inspector findings를 필터링하여 실제 서비스에 영향 있는 취약점만 관리하도록 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너 이미지 취약점은 발견 후 즉각적인 패치 또는 격리 조치를 취하도록 권고하며, 지속적인 모니터링 프로세스를 요구한다.


## 적용 시 체크리스트

- [ ] 서비스(레포)별 SUPPRESS 필터가 생성되어 있는가?
- [ ] ACTIVE findings에서 서비스 런타임과 무관한 패키지 취약점이 제거되어 있는가?
- [ ] 억제된 findings가 SUPPRESSED 상태로 보관되어 있는가?
- [ ] 취약점 심각도별 판단 기준과 조치 기한이 문서화되어 있는가?
- [ ] 서비스 런타임 변경 시 억제 규칙 갱신 프로세스가 수립되어 있는가?

---
