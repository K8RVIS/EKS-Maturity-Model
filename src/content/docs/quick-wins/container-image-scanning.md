---
title: "Container Image Scan 및 차단을 한다"
description: "컨테이너 이미지는 OS 패키지, 언어 런타임, 애플리케이션 의존성, 빌드 산출물, 설정 파일이 함께 들어 있는 복합 아티팩트다. 이 중 하나라도 알려진 CVE를 포함하면 해당 이미지를 기반으로 실행되는 모든 Pod가 같은 취약점을 공유한다."
phase: "Quick Wins"
domain: "Pod 보안"
difficulty: "★★☆"
owner: "공통 (전체 실습)"
order: 70
sidebar:
  order: 70
---

## 왜 필요한가

컨테이너 이미지는 OS 패키지, 언어 런타임, 애플리케이션 의존성, 빌드 산출물, 설정 파일이 함께 들어 있는 복합 아티팩트다. 이 중 하나라도 알려진 CVE를 포함하면 해당 이미지를 기반으로 실행되는 모든 Pod가 같은 취약점을 공유한다.

이미지 취약점은 두 시점에 위협이 된다.

- **push 전:** 이미 알려진 CVE가 포함된 이미지가 검사 없이 그대로 배포된다.
- **push 후:** 레지스트리에 올라간 이미지에 새로운 CVE가 공개된다.

ECR 향상된 스캔으로 push 시점에 취약점을 탐지하고, Inspector CONTINUOUS_SCAN으로 배포 후 새로운 CVE를 지속 감시한다.

이미지 스캔은 런타임 보안 도구를 대체하지 않는다. 다만 취약한 이미지가 클러스터에 들어오는 시점을 앞단에서 차단하므로, EKS 워크로드의 공격 표면을 가장 빠르게 줄일 수 있는 Quick Wins 항목이다.

---

## 수행 방법

**사전 조건**

- 이미지를 ECR에 push하는 AWS 계정과 리전에 접근할 수 있어야 한다.
- ECR repository 또는 private registry의 스캔 설정을 변경할 권한이 있어야 한다.

### Step 1: 현황을 파악한다

ECR 스캐닝 설정과 Inspector v2 활성화 상태를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr get-registry-scanning-configuration \
  --region ap-northeast-2
```

현황 파악에서 다음 문제점을 확인한다.

- ECR 스캐닝이 `BASIC` 수준이거나 설정되지 않음 → push 시점에만 스캔, 이후 신규 CVE 무방비
- ECR 태그가 `MUTABLE` → 동일 태그로 취약한 이미지 덮어쓰기 가능

### Step 2: ECR 향상된 스캔과 Amazon Inspector v2를 활성화한다

ECR은 기본 스캔과 Amazon Inspector 기반의 향상된 스캔을 제공한다.

| 항목 | ECR 기본 스캔 | ECR 향상된 스캔 |
| --- | --- | --- |
| 주요 목적 | ECR 이미지 취약점 기본 탐지 | 지속적 취약점 관리 |
| 탐지 범위 | 주로 OS 패키지 취약점 | OS 패키지와 언어 패키지 취약점 |
| 스캔 주기 | 수동 또는 push 시 스캔 | push 시 스캔 또는 지속 스캔 |
| 이벤트 연동 | ECR scan findings 조회 | Amazon Inspector, Security Hub 연동 |
| 비용 | 기본 기능은 추가 비용 없음 | Amazon Inspector 과금 대상 |

Terraform으로 향상된 스캔과 Inspector v2를 활성화한다. Inspector가 활성화되어야 `ENHANCED`로 전환할 수 있으므로 `depends_on`으로 순서를 명시한다.

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

### Step 3: 이미지 수정과 재빌드 기준을 정한다

스캔에서 취약점이 발견되면 다음 순서로 조치한다.

1. 베이스 이미지를 최신 패치 버전 또는 경량 이미지로 교체한다. 예: `nginx:1.27.5` → `nginx:1.28-alpine`
2. OS 패키지 업데이트가 필요한 경우 Dockerfile에서 패키지 버전을 갱신한다.
3. npm, pip, Maven, Gradle 등 언어 패키지 lock file을 업데이트한다.
4. 사용하지 않는 패키지와 빌드 도구는 runtime 이미지에서 제거한다.
5. 이미지를 다시 빌드하고 ECR 스캔 결과를 재확인한다.

Alpine 기반 이미지는 Debian 기반 이미지보다 불필요한 OS 패키지가 적어 CVE 노출 면적이 줄어든다.

이미지 스캔을 통과한 이미지라도 시간이 지나면 새 CVE가 공개될 수 있다. ECR 향상된 스캔의 CONTINUOUS_SCAN으로 이미 저장된 이미지의 상태도 계속 확인한다.

---

## 검증 방법

ECR 향상된 스캔 설정이 적용되었는지 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr get-registry-scanning-configuration \
  --region ap-northeast-2
```

기대 결과: `scanType`이 `ENHANCED`, `scanFrequency`가 `CONTINUOUS_SCAN`으로 표시된다.

ECR 리포지토리 태그 불변성과 암호화 설정을 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws ecr describe-repositories \
  --region ap-northeast-2 \
  --query 'repositories[*].{Name:repositoryName,TagMutability:imageTagMutability,Encryption:encryptionConfiguration.encryptionType}'
```

기대 결과: `imageTagMutability`가 `IMMUTABLE`, `encryptionType`이 `KMS`로 표시된다.

Inspector findings를 조회해 탐지된 취약점을 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 list-findings \
  --filter-criteria '{
    "resourceType": [{"comparison":"EQUALS","value":"AWS_ECR_CONTAINER_IMAGE"}],
    "severity": [{"comparison":"EQUALS","value":"CRITICAL"},{"comparison":"EQUALS","value":"HIGH"}]
  }' \
  --region ap-northeast-2
```

Inspector v2 활성화 상태를 확인한다.

```bash
AWS_PROFILE=<PROFILE> aws inspector2 get-member \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --region ap-northeast-2
```

**검증 완료 기준**

- ECR 리포지토리 태그가 `IMMUTABLE`, 암호화가 `KMS`로 설정되어 있다.
- ECR registry scanning configuration이 `ENHANCED` + `CONTINUOUS_SCAN`으로 설정되어 있다.
- Inspector v2 ECR 상태가 `ENABLED`로 확인된다.

---

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 공개된 RCE 취약점이 포함된 웹 프레임워크, OpenSSL, Java 라이브러리, Node.js 패키지를 악용해 Pod 내부에서 명령을 실행한다. 이후 서비스 계정 토큰, 환경변수, 마운트된 Secret, 내부 API endpoint를 이용해 추가 침해를 시도한다.
- **공급망 시나리오 예시:** 오래된 베이스 이미지나 패치되지 않은 언어 패키지가 여러 서비스 이미지에 복제되어, 하나의 CVE가 다수 Pod와 네임스페이스에 동시에 영향을 준다.
- **운영 리스크:** 취약점이 배포 후 발견되면 긴급 이미지 재빌드, 배포 중단, 취약 Pod 재시작, 영향 범위 분석이 필요하다. 배포 전 차단보다 대응 비용이 크다.
- **영향 범위:** 원격 코드 실행, 민감 데이터 유출, 서비스 계정 권한 탈취, 내부 네트워크 정찰, 이미지 재빌드 및 긴급 배포로 인한 운영 부담
- **심각도:** **높음**. 컨테이너 이미지 취약점은 동일 이미지를 사용하는 모든 Pod에 반복적으로 전파되며, RCE 취약점과 결합되면 클러스터 침해의 초기 진입점이 될 수 있다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| AWS 추가 비용 | ECR 기본 스캔은 추가 비용 없음. Amazon Inspector 기반 향상된 스캔은 스캔 대상 이미지와 사용량에 따라 비용 발생 |
| 도구 비용 | GitHub Advanced Security, 상용 이미지 스캐너, CSPM/CNAPP 도입 시 별도 비용 발생 |
| 운영 고려사항 | ECR 향상된 스캔 활성화 후 기존 이미지에 대한 findings가 다수 발생할 수 있다. 초기에는 findings를 검토하고 조치 우선순위를 정해야 한다. |

---

## Assessment 체크리스트

- [ ] ECR registry scanning configuration이 `ENHANCED` + `CONTINUOUS_SCAN`으로 설정되어 있는가?
- [ ] Amazon Inspector v2 ECR 스캔이 `ENABLED` 상태인가?
- [ ] ECR 리포지토리 태그가 `IMMUTABLE`로 설정되어 있는가?
- [ ] ECR 이미지 암호화가 `KMS`로 설정되어 있는가?
- [ ] Inspector findings에서 Critical/High 취약점을 정기적으로 확인하는가?

---

## 참고 자료

- [Amazon ECR - Scan images for software vulnerabilities](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [Amazon Inspector - Scanning Amazon ECR container images](https://docs.aws.amazon.com/inspector/latest/user/scanning-ecr.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  컨테이너 이미지와 워크로드 보안은 취약한 이미지 사용을 줄이고, 검증된 이미지 공급망을 유지하는 운영 통제와 연결된다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너 이미지는 최신 패치 상태를 유지하고, 취약점 스캔을 통해 알려진 취약한 구성 요소를 배포 전에 식별하도록 권고한다.
- **AWS EKS Best Practices**
  ECR 이미지 스캔, Amazon Inspector를 조합해 워크로드 이미지의 취약점을 지속적으로 관리하는 것을 권장한다.

