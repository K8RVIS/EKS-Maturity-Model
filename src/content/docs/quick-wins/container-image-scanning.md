---
title: "컨테이너 이미지를 배포 전 스캔하고 Critical/High 취약점 배포를 차단한다"
description: "왜 필요한가"
phase: "Quick Wins"
domain: "Pod 보안"
difficulty: "★☆☆"
owner: "공통 (전체 실습)"
order: 70
sidebar:
  order: 70
---

#### 왜 필요한가

컨테이너 이미지는 OS 패키지, 언어 런타임, 애플리케이션 의존성, 빌드 산출물, 설정 파일이 함께 들어 있는 복합 아티팩트다. 이 중 하나라도 알려진 CVE를 포함하면 해당 이미지를 기반으로 실행되는 모든 Pod가 같은 취약점을 공유한다.

예를 들어 웹 애플리케이션 이미지는 안전해 보여도, 베이스 이미지의 OpenSSL, glibc, curl, Python/Node.js 런타임, npm/pip 패키지 중 하나에 원격 코드 실행(RCE), 인증 우회, 임의 파일 읽기 취약점이 존재할 수 있다. 이미 배포된 뒤 취약점을 찾으면 실행 중인 Pod 교체, 롤백, 영향 범위 분석까지 필요하므로 대응 비용이 커진다.

이미지 취약점 탐지의 목표는 다음과 같다.

- CI/CD 파이프라인에서 이미지를 빌드한 직후 Trivy로 취약점을 스캔한다.
- `CRITICAL` 또는 `HIGH` 취약점이 발견되면 빌드 또는 배포를 실패시킨다.
- ECR 이미지 스캔을 활성화해 레지스트리에 저장된 이미지의 취약점도 지속적으로 확인한다.
- 스캔 결과를 리포트와 이벤트로 남겨 취약점 조치 상태를 추적한다.

이미지 스캔은 런타임 보안 도구를 대체하지 않는다. 다만 취약한 이미지가 클러스터에 들어오는 시점을 앞단에서 차단하므로, EKS 워크로드의 공격 표면을 가장 빠르게 줄일 수 있는 Quick Wins 항목이다.

#### 수행 방법

**사전 조건**

- 컨테이너 이미지를 빌드하는 CI/CD 파이프라인이 있어야 한다.
- Trivy를 CI에서 실행할 수 있어야 한다.
- 이미지를 ECR에 push하는 AWS 계정과 리전에 접근할 수 있어야 한다.
- ECR repository 또는 private registry의 스캔 설정을 변경할 권한이 있어야 한다.
- 취약점 허용 기준을 정해야 한다. 예: `CRITICAL,HIGH` 발견 시 실패, `MEDIUM`은 리포트만 생성

**Step 1: 스캔 기준을 정의한다**

먼저 어떤 결과에서 파이프라인을 중단할지 정한다. 실습과 초기 운영 기준은 다음처럼 단순하게 시작한다.

| 항목 | 권장 기준 |
| --- | --- |
| 차단 심각도 | `CRITICAL,HIGH` |
| 리포트 심각도 | `CRITICAL,HIGH,MEDIUM` |
| 실패 조건 | 차단 심각도의 취약점이 1개 이상 존재 |
| 예외 처리 | false positive 또는 패치 미제공 취약점은 만료일이 있는 `.trivyignore`로 관리 |
| 스캔 시점 | 이미지 빌드 직후, ECR push 전 |
| 보조 스캔 | ECR scan on push 또는 enhanced scanning |

`--ignore-unfixed`는 아직 패치가 제공되지 않은 취약점을 제외할 수 있어 노이즈를 줄인다. 하지만 운영에서는 숨겨진 위험이 될 수 있으므로, 사용 여부를 팀 기준으로 명시해야 한다. 처음에는 전체 결과를 확인하고, 반복적으로 조치 불가능한 항목만 제한적으로 예외 처리한다.

**Step 2: 로컬 또는 CI에서 Trivy로 이미지를 스캔한다**

이미지를 빌드한 뒤 Trivy를 실행한다.

```bash
IMAGE_NAME=<account-id>.dkr.ecr.ap-northeast-2.amazonaws.com/web:<tag>

docker build -t "$IMAGE_NAME" .

trivy image \
  --severity CRITICAL,HIGH \
  --exit-code 1 \
  --format table \
  "$IMAGE_NAME"
```

핵심 옵션은 다음과 같다.

| 옵션 | 목적 |
| --- | --- |
| `image` | 컨테이너 이미지 스캔 |
| `--severity CRITICAL,HIGH` | 차단 대상으로 볼 심각도 제한 |
| `--exit-code 1` | 취약점 발견 시 프로세스 종료 코드를 1로 반환해 CI 실패 처리 |
| `--format table` | 사람이 읽기 쉬운 콘솔 출력 |

스캔 리포트를 보관하려면 JSON 또는 SARIF도 함께 생성한다.

```bash
trivy image \
  --severity CRITICAL,HIGH,MEDIUM \
  --format json \
  --output trivy-image-report.json \
  "$IMAGE_NAME"
```

**Step 3: GitHub Actions 파이프라인에 Trivy를 통합한다**

GitHub Actions를 사용한다면 이미지 빌드 후 push 전에 스캔 단계를 추가한다.

```yaml
name: image-security

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  scan-image:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      security-events: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Build image
        run: |
          docker build -t local/web:${{ github.sha }} .

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@0.35.0
        with:
          image-ref: local/web:${{ github.sha }}
          vuln-type: os,library
          severity: CRITICAL,HIGH
          exit-code: "1"
          format: table
```

CI에서 GitHub Action을 사용할 때는 액션 버전을 고정하고, 보안 권고를 확인한다. Trivy 생태계는 2026년 3월 공급망 침해 이력이 있으므로 `aquasecurity/trivy-action`은 패치된 버전을 사용하고, 조직 정책이 허용하면 SHA pinning도 검토한다. 보안 도구 자체도 공급망의 일부이므로 최신 권고 확인과 버전 관리가 필요하다.

SARIF를 GitHub Code Scanning에 업로드하려면 별도 스캔 단계를 추가한다.

```yaml
      - name: Generate Trivy SARIF report
        uses: aquasecurity/trivy-action@0.35.0
        with:
          image-ref: local/web:${{ github.sha }}
          vuln-type: os,library
          severity: CRITICAL,HIGH,MEDIUM
          exit-code: "0"
          format: sarif
          output: trivy-results.sarif

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
```

첫 번째 스캔은 `exit-code: "1"`로 배포 차단에 사용하고, 두 번째 스캔은 `exit-code: "0"`으로 리포트 업로드에 사용한다. 이렇게 분리하면 파이프라인 실패 여부와 리포트 보관 목적을 명확히 나눌 수 있다.

**Step 4: ECR 기본 스캔 또는 향상된 스캔을 활성화한다**

ECR은 기본 스캔과 Amazon Inspector 기반의 향상된 스캔을 제공한다.

| 항목 | ECR 기본 스캔 | ECR 향상된 스캔 |
| --- | --- | --- |
| 주요 목적 | ECR 이미지 취약점 기본 탐지 | 지속적 취약점 관리 |
| 탐지 범위 | 주로 OS 패키지 취약점 | OS 패키지와 언어 패키지 취약점 |
| 스캔 주기 | 수동 또는 push 시 스캔 | push 시 스캔 또는 지속 스캔 |
| 이벤트 연동 | ECR scan findings 조회 | Amazon Inspector, EventBridge, Security Hub 연동 |
| 비용 | 기본 기능은 추가 비용 없음 | Amazon Inspector 과금 대상 |
| 권장 사용 | 실습, 초기 도입 | 운영 환경, 다수 계정/레지스트리 관리 |

실습 환경에서는 ECR scan on push를 먼저 활성화하고, 운영 환경에서는 Amazon Inspector 기반 향상된 스캔을 우선 검토한다.

기본 스캔을 scan on push로 활성화하는 예시는 다음과 같다.

```bash
aws ecr put-image-scanning-configuration \
  --repository-name web \
  --image-scanning-configuration scanOnPush=true \
  --region ap-northeast-2
```

레지스트리 단위로 향상된 스캔을 적용하려면 registry scanning configuration을 설정한다.

```bash
aws ecr put-registry-scanning-configuration \
  --scan-type ENHANCED \
  --rules '[
    {
      "scanFrequency": "CONTINUOUS_SCAN",
      "repositoryFilters": [
        {
          "filter": "*",
          "filterType": "WILDCARD"
        }
      ]
    }
  ]' \
  --region ap-northeast-2
```

향상된 스캔은 Amazon Inspector와 연동되므로, 계정과 리전에서 Inspector 활성화 상태와 비용 정책을 함께 확인한다.

**Step 5: 취약점 예외를 통제한다**

모든 취약점을 즉시 제거하기 어려울 수 있다. 예외는 허용하되, 파일에 이유와 만료일을 남긴다.

```text
# .trivyignore
# CVE-2026-0000
# reason: upstream patch not available for base image
# expires: 2026-05-31
CVE-2026-0000
```

예외 운영 원칙은 다음과 같다.

- `CRITICAL` 취약점 예외는 보안 담당자 승인을 요구한다.
- 예외에는 조치 불가 사유와 만료일을 남긴다.
- 만료된 예외는 CI에서 실패하도록 정기적으로 점검한다.
- 베이스 이미지 업데이트나 의존성 패치가 가능해지면 예외를 제거한다.

**Step 6: 이미지 수정과 재빌드 기준을 정한다**

스캔에서 취약점이 발견되면 다음 순서로 조치한다.

1. 베이스 이미지를 최신 패치 버전으로 올린다. 예: `node:22-alpine3.20`에서 패치 릴리스로 갱신
2. OS 패키지 업데이트가 필요한 경우 Dockerfile에서 패키지 버전을 갱신한다.
3. npm, pip, Maven, Gradle 등 언어 패키지 lock file을 업데이트한다.
4. 사용하지 않는 패키지와 빌드 도구는 runtime 이미지에서 제거한다.
5. 이미지를 다시 빌드하고 Trivy 및 ECR 스캔 결과를 재확인한다.

이미지 스캔을 통과한 이미지라도 시간이 지나면 새 CVE가 공개될 수 있다. 따라서 ECR 향상된 스캔 또는 주기적 재스캔으로 이미 저장된 이미지의 상태도 계속 확인해야 한다.

#### 검증 방법

CI/CD 파이프라인에서 Trivy가 실제로 배포를 차단하는지 테스트한다.

```bash
trivy image \
  --severity CRITICAL,HIGH \
  --exit-code 1 \
  vulnerables/web-dvwa
```

기대 결과는 `CRITICAL` 또는 `HIGH` 취약점이 표시되고 종료 코드가 1로 반환되는 것이다.

```bash
echo $?
# 기대 결과: 1
```

GitHub Actions에서는 해당 step과 job이 실패해야 한다.

- Trivy step이 실패 상태로 표시된다.
- 이후 ECR push 또는 배포 step이 실행되지 않는다.
- 스캔 로그에 취약한 패키지명, CVE, 심각도, 설치 버전, 수정 버전이 표시된다.

ECR scan on push가 활성화되었는지 확인한다.

```bash
aws ecr describe-repositories \
  --repository-names web \
  --region ap-northeast-2 \
  --query 'repositories[0].imageScanningConfiguration'
```

기대 결과는 다음과 같다.

```json
{
  "scanOnPush": true
}
```

ECR 스캔 결과를 조회한다.

```bash
IMAGE_DIGEST=$(aws ecr describe-images \
  --repository-name web \
  --image-ids imageTag=<tag> \
  --region ap-northeast-2 \
  --query 'imageDetails[0].imageDigest' \
  --output text)

aws ecr describe-image-scan-findings \
  --repository-name web \
  --image-id imageDigest="$IMAGE_DIGEST" \
  --region ap-northeast-2
```

기대 결과:

- 스캔 상태가 `COMPLETE` 또는 Inspector 연동 결과로 확인된다.
- `findingSeverityCounts` 또는 findings 목록에 심각도별 개수가 표시된다.
- 취약점이 없는 이미지에서는 `HIGH`, `CRITICAL` 개수가 0으로 표시된다.

향상된 스캔을 사용하는 경우 Inspector finding도 확인한다.

```bash
aws inspector2 list-findings \
  --filter-criteria '{
    "resourceType": [
      {
        "comparison": "EQUALS",
        "value": "AWS_ECR_CONTAINER_IMAGE"
      }
    ],
    "severity": [
      {
        "comparison": "EQUALS",
        "value": "CRITICAL"
      },
      {
        "comparison": "EQUALS",
        "value": "HIGH"
      }
    ]
  }' \
  --region ap-northeast-2
```

검증 완료 기준은 다음과 같다.

- 취약한 테스트 이미지에서 CI job이 실패한다.
- 안전한 이미지에서는 CI job이 통과한다.
- ECR repository의 scan on push 또는 enhanced scanning 설정이 활성화되어 있다.
- 스캔 리포트가 빌드 산출물, Code Scanning, Security Hub, Inspector 중 최소 한 곳에 남는다.
- Critical/High 발견 시 배포 단계가 실행되지 않는다.

#### Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 공개된 RCE 취약점이 포함된 웹 프레임워크, OpenSSL, Java 라이브러리, Node.js 패키지를 악용해 Pod 내부에서 명령을 실행한다. 이후 서비스 계정 토큰, 환경변수, 마운트된 Secret, 내부 API endpoint를 이용해 추가 침해를 시도한다.
- **공급망 시나리오 예시:** 오래된 베이스 이미지나 패치되지 않은 언어 패키지가 여러 서비스 이미지에 복제되어, 하나의 CVE가 다수 Pod와 네임스페이스에 동시에 영향을 준다.
- **운영 리스크:** 취약점이 배포 후 발견되면 긴급 이미지 재빌드, 배포 중단, 취약 Pod 재시작, 영향 범위 분석이 필요하다. 배포 전 차단보다 대응 비용이 크다.
- **영향 범위:** 원격 코드 실행, 민감 데이터 유출, 서비스 계정 권한 탈취, 내부 네트워크 정찰, 이미지 재빌드 및 긴급 배포로 인한 운영 부담
- **심각도:** **높음**. 컨테이너 이미지 취약점은 동일 이미지를 사용하는 모든 Pod에 반복적으로 전파되며, RCE 취약점과 결합되면 클러스터 침해의 초기 진입점이 될 수 있다.

#### 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| 예상 소요 시간 | Trivy CI 통합 30분~1시간, ECR 스캔 활성화 30분, 실패 조건 검증 30분 |
| AWS 추가 비용 | ECR 기본 스캔은 추가 비용 없음. Amazon Inspector 기반 향상된 스캔은 스캔 대상 이미지와 사용량에 따라 비용 발생 |
| 도구 비용 | Trivy는 오픈소스. GitHub Advanced Security, 상용 이미지 스캐너, CSPM/CNAPP 도입 시 별도 비용 발생 |
| 운영 고려사항 | false positive, 패치 미제공 취약점, 스캔 DB 업데이트 지연, CI 실행 시간 증가를 고려해 예외 정책과 리포트 보관 방식을 정해야 한다. |

#### 참고 자료

- [Trivy 공식 문서 - Vulnerability Scanning](https://trivy.dev/docs/dev/guide/scanner/vulnerability/)
- [Trivy 공식 문서 - CI/CD Integrations](https://trivy.dev/docs/dev/ecosystem/cicd/)
- [aquasecurity/trivy-action](https://github.com/aquasecurity/trivy-action)
- [GitHub Advisory - Trivy ecosystem supply chain temporarily compromised](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
- [Amazon ECR - Scan images for software vulnerabilities](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [Amazon ECR - Configuring basic scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-basic-enabling.html)
- [Amazon Inspector - Scanning Amazon ECR container images](https://docs.aws.amazon.com/inspector/latest/user/scanning-ecr.html)
- [CIS Kubernetes Benchmark v1.12.0](../CIS_Kubernetes_Benchmark_V1.12.0_PDF.md)
- [NSA/CISA Kubernetes Hardening Guidance](../CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.md)

#### 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  컨테이너 이미지와 워크로드 보안은 취약한 이미지 사용을 줄이고, 검증된 이미지 공급망을 유지하는 운영 통제와 연결된다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너 이미지는 최신 패치 상태를 유지하고, 취약점 스캔을 통해 알려진 취약한 구성 요소를 배포 전에 식별하도록 권고한다.
- **AWS EKS Best Practices**
  ECR 이미지 스캔, Amazon Inspector, CI/CD 보안 검사를 조합해 워크로드 이미지의 취약점을 지속적으로 관리하는 것을 권장한다.

#### Assessment 체크리스트

- [ ] CI/CD 파이프라인에 Trivy 이미지 스캔 단계가 포함되어 있는가?
- [ ] `CRITICAL` 또는 `HIGH` 취약점 발견 시 CI job이 실패하도록 설정되어 있는가?
- [ ] 취약점 리포트가 JSON, SARIF, 빌드 산출물, Code Scanning 중 하나 이상으로 보관되는가?
- [ ] ECR repository 또는 registry 단위로 scan on push가 활성화되어 있는가?
- [ ] 운영 환경에서 Amazon Inspector 기반 ECR enhanced scanning 도입 여부를 검토했는가?
- [ ] 취약한 테스트 이미지로 빌드/배포 자동 중단을 검증했는가?
- [ ] `.trivyignore` 같은 예외 파일에 사유와 만료일을 남기고 주기적으로 검토하는가?
- [ ] 베이스 이미지와 애플리케이션 의존성을 정기적으로 업데이트하는 절차가 있는가?
- [ ] Trivy Action 또는 Trivy 바이너리 버전을 고정하고 보안 권고를 확인하는가?
- [ ] 이미 배포된 이미지에 새 CVE가 생겼을 때 재빌드와 재배포 절차가 정의되어 있는가?

