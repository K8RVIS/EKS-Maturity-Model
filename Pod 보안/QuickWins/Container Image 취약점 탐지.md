# 컨테이너 이미지를 배포 전 스캔하고 Critical/High 취약점 배포를 차단한다

> **Phase:** Quick Wins
>
> **보안 영역:** Pod 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

## 왜 필요한가

컨테이너 이미지는 OS 패키지, 언어 런타임, 애플리케이션 의존성, 빌드 산출물, 설정 파일이 함께 들어 있는 복합 아티팩트다. 이 중 하나라도 알려진 CVE를 포함하면 해당 이미지를 기반으로 실행되는 모든 Pod가 같은 취약점을 공유한다.

이미지 취약점은 두 시점에 위협이 된다.

- **push 전:** 이미 알려진 CVE가 포함된 이미지가 검사 없이 그대로 배포된다.
- **push 후:** 레지스트리에 올라간 이미지에 새로운 CVE가 공개된다.

Trivy CI 스캔으로 전자를 배포 전에 차단하고, Inspector CONTINUOUS_SCAN으로 후자를 지속 감시한다. 이미지 목록을 하드코딩하지 않고 매니페스트에서 자동 추출하는 이유는, 이미지가 추가·변경될 때 워크플로우 수동 수정 없이도 스캔 대상이 항상 실제 배포 이미지와 일치하게 하기 위해서다.

이미지 스캔은 런타임 보안 도구를 대체하지 않는다. 다만 취약한 이미지가 클러스터에 들어오는 시점을 앞단에서 차단하므로, EKS 워크로드의 공격 표면을 가장 빠르게 줄일 수 있는 Quick Wins 항목이다.

## 수행 방법

**사전 조건**

- 컨테이너 이미지를 빌드하는 CI/CD 파이프라인이 있어야 한다.
- Trivy를 CI에서 실행할 수 있어야 한다.
- 이미지를 ECR에 push하는 AWS 계정과 리전에 접근할 수 있어야 한다.
- ECR repository 또는 private registry의 스캔 설정을 변경할 권한이 있어야 한다.
- 취약점 허용 기준을 정해야 한다. 예: `CRITICAL,HIGH` 발견 시 실패, `MEDIUM`은 리포트만 생성

**Step 1: 현황을 파악한다**

적용 전에 매니페스트에 어떤 이미지가 있는지, ECR 스캔 설정과 Inspector 상태가 어떤지 확인한다.

매니페스트에 등록된 이미지 목록을 확인한다.

```bash
python3 scripts/list_manifest_images.py manifests
```

ECR 스캐닝 설정을 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr get-registry-scanning-configuration \
  --region <region>
```

Inspector v2 활성화 상태를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 batch-get-account-status \
  --account-ids $(AWS_PROFILE=<PROFILE> aws sts get-caller-identity --query Account --output text) \
  --region <region>
```

현황 파악에서 다음 문제점을 확인한다.

- ECR 스캐닝이 `BASIC` 수준이거나 설정되지 않음 → push 시점에만 스캔, 이후 신규 CVE 무방비
- CI에서 이미지 취약점 검사 없음 → 취약한 이미지가 그대로 배포됨
- ECR 태그가 `MUTABLE` → 동일 태그로 취약한 이미지 덮어쓰기 가능

**Step 2: 스캔 기준을 정의한다**

먼저 어떤 결과에서 파이프라인을 중단할지 정한다. 실습과 초기 운영 기준은 다음처럼 단순하게 시작한다.

| 항목 | 권장 기준 |
| --- | --- |
| 차단 심각도 | `CRITICAL,HIGH` |
| 리포트 심각도 | `CRITICAL,HIGH,MEDIUM` |
| 실패 조건 | 차단 심각도의 취약점이 1개 이상 존재 |
| 예외 처리 | false positive 또는 패치 미제공 취약점은 만료일이 있는 `.trivyignore`로 관리 |
| 스캔 시점 | PR 생성 시 매니페스트에서 추출한 이미지 대상 |
| 보조 스캔 | ECR enhanced scanning + Amazon Inspector v2 지속 스캔 |

`--ignore-unfixed`는 아직 패치가 제공되지 않은 취약점을 제외할 수 있어 노이즈를 줄인다. 하지만 운영에서는 숨겨진 위험이 될 수 있으므로, 사용 여부를 팀 기준으로 명시해야 한다. 처음에는 전체 결과를 확인하고, 반복적으로 조치 불가능한 항목만 제한적으로 예외 처리한다.

**Step 3: 매니페스트에서 이미지 목록을 추출한다**

스캔 대상 이미지를 자동으로 식별하기 위해 매니페스트 전체에서 이미지 목록을 추출한다.

```bash
python3 scripts/list_manifest_images.py manifests
```

스크립트는 `manifests/` 하위의 모든 YAML 파일을 순회하며 `image:` 필드를 추출한다. 추출된 이미지 목록은 CI에서 각 이미지에 대해 Trivy를 순차 실행하는 데 사용된다.

**Step 4: 로컬에서 Trivy로 이미지를 스캔한다**

이미지 목록이 확인되면 로컬에서 먼저 스캔해 취약점 현황을 파악한다.

```bash
trivy image \
  --severity CRITICAL,HIGH \
  --exit-code 1 \
  --format table \
  nginx:1.27.5
```

핵심 옵션은 다음과 같다.

| 옵션 | 목적 |
| --- | --- |
| `image` | 컨테이너 이미지 스캔 |
| `--severity CRITICAL,HIGH` | 차단 대상으로 볼 심각도 제한 |
| `--exit-code 1` | 취약점 발견 시 프로세스 종료 코드를 1로 반환해 CI 실패 처리 |
| `--format table` | 사람이 읽기 쉬운 콘솔 출력 |

스캔 리포트를 보관하려면 SARIF도 함께 생성한다.

```bash
trivy image \
  --severity CRITICAL,HIGH,MEDIUM \
  --format sarif \
  --output trivy-results.sarif \
  nginx:1.27.5
```

**Step 5: GitHub Actions 파이프라인에 Trivy를 통합한다**

PR 생성 시 매니페스트에서 이미지를 추출하고 각 이미지에 대해 Trivy를 실행하는 워크플로우를 추가한다.

```yaml
name: Container Image Scan

on:
  pull_request:

jobs:
  extract-images:
    runs-on: ubuntu-24.04
    outputs:
      images: ${{ steps.extract.outputs.images }}
    steps:
      - uses: actions/checkout@v4
      - name: Extract images from manifests
        id: extract
        run: |
          images=$(python3 scripts/list_manifest_images.py manifests)
          echo "images=$images" >> $GITHUB_OUTPUT

  scan:
    needs: extract-images
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        image: ${{ fromJson(needs.extract-images.outputs.images) }}
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@0.35.0
        with:
          image-ref: ${{ matrix.image }}
          vuln-type: os,library
          severity: CRITICAL,HIGH
          exit-code: "1"
          format: table

      - name: Generate Trivy SARIF report
        uses: aquasecurity/trivy-action@0.35.0
        with:
          image-ref: ${{ matrix.image }}
          vuln-type: os,library
          severity: CRITICAL,HIGH,MEDIUM
          exit-code: "0"
          format: sarif
          output: trivy-results.sarif

      - name: Upload Trivy scan results to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
```

CI에서 GitHub Action을 사용할 때는 액션 버전을 고정하고, 보안 권고를 확인한다. Trivy 생태계는 2026년 3월 공급망 침해 이력이 있으므로 `aquasecurity/trivy-action`은 패치된 버전을 사용하고, 조직 정책이 허용하면 SHA pinning도 검토한다.

첫 번째 스캔은 `exit-code: "1"`로 배포 차단에 사용하고, 두 번째 스캔은 `exit-code: "0"`으로 SARIF 리포트 업로드에 사용한다. 이렇게 분리하면 파이프라인 실패 여부와 리포트 보관 목적을 명확히 나눌 수 있다.

**Step 6: ECR 향상된 스캔과 Amazon Inspector v2를 활성화한다**

ECR은 기본 스캔과 Amazon Inspector 기반의 향상된 스캔을 제공한다.

| 항목 | ECR 기본 스캔 | ECR 향상된 스캔 |
| --- | --- | --- |
| 주요 목적 | ECR 이미지 취약점 기본 탐지 | 지속적 취약점 관리 |
| 탐지 범위 | 주로 OS 패키지 취약점 | OS 패키지와 언어 패키지 취약점 |
| 스캔 주기 | 수동 또는 push 시 스캔 | push 시 스캔 또는 지속 스캔 |
| 이벤트 연동 | ECR scan findings 조회 | Amazon Inspector, Security Hub 연동 |
| 비용 | 기본 기능은 추가 비용 없음 | Amazon Inspector 과금 대상 |

Terraform으로 향상된 스캔과 Inspector v2를 활성화한다.

```hcl
resource "aws_inspector2_enabler" "ecr" {
  account_ids    = [data.aws_caller_identity.current.account_id]
  resource_types = ["ECR"]
}

resource "aws_ecr_registry_scanning_configuration" "this" {
  scan_type = "ENHANCED"

  rule {
    scan_frequency = "CONTINUOUS_SCAN"

    repository_filter {
      filter      = "${var.project_name}/*"
      filter_type = "WILDCARD"
    }
  }

  depends_on = [aws_inspector2_enabler.ecr]
}
```

Inspector가 활성화되어야 registry scanning configuration을 `ENHANCED`로 전환할 수 있으므로 `depends_on`으로 순서를 명시한다. 적용은 인프라 디렉터리에서 실행한다.

```bash
cd environments/infra
terraform init
terraform apply
```

**Step 7: 취약점 예외를 통제한다**

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

**Step 8: 이미지 수정과 재빌드 기준을 정한다**

스캔에서 취약점이 발견되면 다음 순서로 조치한다.

1. 베이스 이미지를 최신 패치 버전 또는 경량 이미지로 교체한다. 예: `nginx:1.27.5` → `nginx:1.28-alpine`
2. OS 패키지 업데이트가 필요한 경우 Dockerfile에서 패키지 버전을 갱신한다.
3. npm, pip, Maven, Gradle 등 언어 패키지 lock file을 업데이트한다.
4. 사용하지 않는 패키지와 빌드 도구는 runtime 이미지에서 제거한다.
5. 이미지를 다시 빌드하고 Trivy 및 ECR 스캔 결과를 재확인한다.

Alpine 기반 이미지는 Debian 기반 이미지보다 불필요한 OS 패키지가 적어 CVE 노출 면적이 줄어든다. kustomize overlay로 특정 네임스페이스에만 적용할 수 있다.

```yaml
# manifests/overlays/<namespace>/web-deployment-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.28-alpine
```

이미지 스캔을 통과한 이미지라도 시간이 지나면 새 CVE가 공개될 수 있다. ECR 향상된 스캔의 CONTINUOUS_SCAN으로 이미 저장된 이미지의 상태도 계속 확인한다.

## 검증 방법

CI/CD 파이프라인에서 Trivy가 실제로 배포를 차단하는지 확인한다. PR을 생성하면 매니페스트에 등록된 이미지에 대해 스캔이 실행되고, CRITICAL/HIGH 취약점이 있는 이미지는 해당 job이 실패한다.

```
failing checks
Container Image Scan / Scan: nginx:1.27.5       ← CRITICAL/HIGH 발견으로 실패
Container Image Scan / Scan: redis:7            ← CRITICAL/HIGH 발견으로 실패
Container Image Scan / Scan: <image>  ← CRITICAL/HIGH 발견으로 실패

successful checks
Code scanning results / Trivy                   ← SARIF 업로드 성공
Container Image Scan / Extract images           ← 이미지 추출 성공
```

ECR 리포지토리 생성 및 설정을 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr describe-repositories \
  --query 'repositories[*].{name:repositoryName,immutable:imageTagMutability,encryption:encryptionConfiguration.encryptionType}' \
  --output table \
  --region <region>
```

기대 결과: `imageTagMutability`가 `IMMUTABLE`, `encryptionType`이 `KMS`로 표시된다.

ECR 향상된 스캔 설정이 적용되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr get-registry-scanning-configuration \
  --region <region>
```

기대 결과:

```json
{
  "scanType": "ENHANCED",
  "rules": [
    {
      "scanFrequency": "CONTINUOUS_SCAN"
    }
  ]
}
```

Amazon Inspector v2 ECR 스캔이 활성화되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 batch-get-account-status \
  --account-ids $(AWS_PROFILE=<PROFILE> aws sts get-caller-identity --query Account --output text) \
  --region <region>
```

기대 결과:

```json
{
  "accounts": [
    {
      "state": { "status": "ENABLED" },
      "resourceState": {
        "ecr": { "status": "ENABLED" }
      }
    }
  ]
}
```

Inspector findings를 조회해 탐지된 취약점을 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "resourceType": [
      { "comparison": "EQUALS", "value": "AWS_ECR_CONTAINER_IMAGE" }
    ],
    "severity": [
      { "comparison": "EQUALS", "value": "CRITICAL" },
      { "comparison": "EQUALS", "value": "HIGH" }
    ]
  }' \
  --region <region>
```

검증 완료 기준은 다음과 같다.

- 취약한 이미지에서 CI job이 실패한다.
- 스캔 리포트가 GitHub Code Scanning에 업로드된다.
- ECR 리포지토리 태그가 `IMMUTABLE`, 암호화가 `KMS`로 설정되어 있다.
- ECR registry scanning configuration이 `ENHANCED` + `CONTINUOUS_SCAN`으로 설정되어 있다.
- Inspector v2 ECR 상태가 `ENABLED`로 확인된다.
- Critical/High 발견 시 배포 단계가 실행되지 않는다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 공개된 RCE 취약점이 포함된 웹 프레임워크, OpenSSL, Java 라이브러리, Node.js 패키지를 악용해 Pod 내부에서 명령을 실행한다. 이후 서비스 계정 토큰, 환경변수, 마운트된 Secret, 내부 API endpoint를 이용해 추가 침해를 시도한다.
- **공급망 시나리오 예시:** 오래된 베이스 이미지나 패치되지 않은 언어 패키지가 여러 서비스 이미지에 복제되어, 하나의 CVE가 다수 Pod와 네임스페이스에 동시에 영향을 준다.
- **운영 리스크:** 취약점이 배포 후 발견되면 긴급 이미지 재빌드, 배포 중단, 취약 Pod 재시작, 영향 범위 분석이 필요하다. 배포 전 차단보다 대응 비용이 크다.
- **영향 범위:** 원격 코드 실행, 민감 데이터 유출, 서비스 계정 권한 탈취, 내부 네트워크 정찰, 이미지 재빌드 및 긴급 배포로 인한 운영 부담
- **심각도:** **높음**. 컨테이너 이미지 취약점은 동일 이미지를 사용하는 모든 Pod에 반복적으로 전파되며, RCE 취약점과 결합되면 클러스터 침해의 초기 진입점이 될 수 있다.

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| 예상 소요 시간 | Trivy CI 통합 30분~1시간, ECR 향상된 스캔 활성화 30분, 실패 조건 검증 30분 |
| AWS 추가 비용 | ECR 기본 스캔은 추가 비용 없음. Amazon Inspector 기반 향상된 스캔은 스캔 대상 이미지와 사용량에 따라 비용 발생 |
| 도구 비용 | Trivy는 오픈소스. GitHub Advanced Security, 상용 이미지 스캐너, CSPM/CNAPP 도입 시 별도 비용 발생 |
| 운영 고려사항 | false positive, 패치 미제공 취약점, 스캔 DB 업데이트 지연, CI 실행 시간 증가를 고려해 예외 정책과 리포트 보관 방식을 정해야 한다. |

## 참고 자료

- [Trivy 공식 문서 - Vulnerability Scanning](https://trivy.dev/docs/dev/guide/scanner/vulnerability/)
- [Trivy 공식 문서 - CI/CD Integrations](https://trivy.dev/docs/dev/ecosystem/cicd/)
- [aquasecurity/trivy-action](https://github.com/aquasecurity/trivy-action)
- [GitHub Advisory - Trivy ecosystem supply chain temporarily compromised](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)
- [Amazon ECR - Scan images for software vulnerabilities](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [Amazon Inspector - Scanning Amazon ECR container images](https://docs.aws.amazon.com/inspector/latest/user/scanning-ecr.html)
- [CIS Kubernetes Benchmark v1.12.0](../CIS_Kubernetes_Benchmark_V1.12.0_PDF.md)
- [NSA/CISA Kubernetes Hardening Guidance](../CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.md)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  컨테이너 이미지와 워크로드 보안은 취약한 이미지 사용을 줄이고, 검증된 이미지 공급망을 유지하는 운영 통제와 연결된다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너 이미지는 최신 패치 상태를 유지하고, 취약점 스캔을 통해 알려진 취약한 구성 요소를 배포 전에 식별하도록 권고한다.
- **AWS EKS Best Practices**
  ECR 이미지 스캔, Amazon Inspector, CI/CD 보안 검사를 조합해 워크로드 이미지의 취약점을 지속적으로 관리하는 것을 권장한다.

## Assessment 체크리스트

- [ ] CI/CD 파이프라인에 Trivy 이미지 스캔 단계가 포함되어 있는가?
- [ ] 매니페스트에서 이미지를 자동으로 추출해 스캔 대상으로 사용하는가?
- [ ] `CRITICAL` 또는 `HIGH` 취약점 발견 시 CI job이 실패하도록 설정되어 있는가?
- [ ] 취약점 리포트가 SARIF 형식으로 GitHub Code Scanning에 업로드되는가?
- [ ] ECR 리포지토리 태그가 `IMMUTABLE`로 설정되어 있는가?
- [ ] ECR registry scanning configuration이 `ENHANCED` + `CONTINUOUS_SCAN`으로 설정되어 있는가?
- [ ] Amazon Inspector v2 ECR 스캔이 `ENABLED` 상태인가?
- [ ] 취약한 테스트 이미지로 빌드/배포 자동 중단을 검증했는가?
- [ ] `.trivyignore`에 사유와 만료일을 남기고 주기적으로 검토하는가?
- [ ] 베이스 이미지를 경량 이미지(Alpine 등)로 교체해 공격 표면을 줄였는가?
- [ ] Trivy Action 버전을 고정하고 보안 권고를 확인하는가?
- [ ] 이미 배포된 이미지에 새 CVE가 생겼을 때 재빌드와 재배포 절차가 정의되어 있는가?
