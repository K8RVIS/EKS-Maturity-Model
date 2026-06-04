# EKS 보안 성숙도 모델

EKS 환경의 보안 통제를 한 번에 적용하는 체크리스트가 아니라, 조직의 운영 여건과 기술 수준에 맞춰 **Quick Wins부터 Optimized까지 단계적으로 보안을 강화할 수 있도록 만든 실전 적용 가이드**입니다.

기존 보안 가이드가 다양한 통제 항목을 나열하는 데 집중했다면 이 프로젝트는 각 항목의 위험도, 적용 난이도, 운영 복잡도를 고려해 개선 순서를 제시합니다. <br>
실습을 통해 적용 과정과 검증 방법을 확인하고, 그 결과를 웹 문서와 EKS 진단 Skill로 제공합니다.

## 프로젝트 범위

Amazon EKS의 Control Plane은 AWS가 관리하므로, 본 프로젝트는 사용자가 직접 관리하고 개선해야 하는 **Data Plane 보안**에 집중합니다.

- 대상 영역: 접근 제어, 네트워크 보안, 데이터 보호, Pod 보안
- 대상 리소스: Worker Node, Pod, Container, NetworkPolicy, RBAC, Secret 등
- 목표: 현재 보안 수준 파악, 보안 공백 식별, 조직 상황에 맞는 우선순위 기반 개선

## 성숙도 단계

| 단계 | 목표 | 적용 특성 |
| --- | --- | --- |
| **Quick Wins** | 구조 변경 없이 기본 보호와 보안 가시성을 빠르게 확보 | 설정 변경 중심, 낮은 적용 난이도와 운영 영향 |
| **Foundational** | 안전한 EKS 운영을 위한 기본 보안 구조 구축 | 클러스터 전반의 기준선 형성과 일관성 확보 |
| **Efficient** | 세부 정책, 감사, 모니터링을 통한 운영 통제 강화 | 정책 설계와 지속적인 관리 필요 |
| **Optimized** | 자동화, 관측성, 이상 탐지 기반의 고도화된 보안 운영 | 설계·자동화·운영 체계를 포함한 높은 성숙도 요구 |

현재 모델은 4개 보안 영역에 걸쳐 총 **31개 보안 통제 항목**을 제공합니다.

| 단계 | 통제 항목 수 |
| --- | ---: |
| Quick Wins | 7 |
| Foundational | 10 |
| Efficient | 7 |
| Optimized | 7 |

## 최종 산출물

### 1. EKS 보안 성숙도 모델

웹 문서에서는 전체 성숙도 매트릭스와 단계별 보안 통제를 확인할 수 있습니다.

각 통제 문서는 다음 내용을 중심으로 구성되어 있습니다.

- 통제가 필요한 이유와 해결하려는 위험
- 적용 전 확인 사항과 구현 예시
- 적용 시 고려해야 할 운영 영향
- 적용 결과를 확인하는 검증 방법과 명령

**바로가기**

- [EKS 보안 성숙도 모델](https://k8rvis.github.io/EKS-Maturity-Model/0-introduction/)
- [전체 성숙도 매트릭스](https://k8rvis.github.io/EKS-Maturity-Model/model/)

### 2. EKS Maturity Advisor Skill

`eks-maturity-advisor`는 EKS 저장소, Kubernetes 매니페스트, 라이브 클러스터를 성숙도 모델 기준으로 진단하는 Codex Skill입니다.

진단 결과는 통제 항목별로 상태, 심각도, 우선순위, 근거, 권장 조치, 읽기 전용 검증 명령을 제공합니다. 기본적으로 저장소와 클러스터를 변경하지 않는 **읽기 전용 진단 도구**로 동작합니다.

주요 기능:

- 저장소와 Kubernetes 매니페스트의 Quick Wins 정적 진단
- `kubectl`과 AWS CLI를 활용한 라이브 클러스터 읽기 전용 진단
- `fail`, `warn`, `unknown`, `pass` 상태 분류
- `P1`, `P2`, `P3` 우선순위 기반 개선 항목 정리
- 성숙도 항목별 위험 설명, 개선 방법, 검증 명령 제공
- kubeconfig를 활용한 EKS 클러스터 정보 자동 감지

Skill 설치:

```bash
npm run skill:install-local
```

이미 설치된 Skill을 교체하려면 다음 명령을 사용합니다.

```bash
npm run skill:install-local -- --force
```

저장소 진단:

```bash
npm run skill:scan -- --repo-root <repository-path> --output markdown
```

라이브 클러스터 자동 감지 진단:

```bash
npm run skill:scan -- --live --auto-detect --output markdown
```

라이브 클러스터 직접 지정 진단:

```bash
npm run skill:scan -- \
  --live \
  --context <kubectl-context> \
  --cluster-name <cluster-name> \
  --region <aws-region> \
  --output markdown
```

Skill은 진단 과정에서 `kubectl apply`, `terraform apply`, `helm upgrade`, `aws eks update-*`와 같은 변경 명령을 실행하지 않습니다.

## 기대 효과

- **보안 수준 파악**: 현재 EKS 환경의 취약 지점과 성숙도 단계를 확인할 수 있습니다.
- **보안 공백 개선**: 영역별로 누락된 통제를 식별하고 구체적인 개선 방향을 도출할 수 있습니다.
- **우선순위 기반 개선**: 모든 통제를 한 번에 적용하지 않고 조직 상황과 운영 역량에 맞춰 단계적으로 적용할 수 있습니다.
- **반복 가능한 진단**: 웹 가이드와 Skill을 함께 활용해 저장소와 클러스터의 개선 상태를 지속적으로 확인할 수 있습니다.

## 저장소 구조

```text
.
├── src/content/docs/                  # 성숙도 단계별 웹 문서
├── src/data/maturity-items.json       # 성숙도 매트릭스 데이터
├── skills/eks-maturity-advisor/       # EKS Maturity Advisor Skill
│   ├── SKILL.md
│   ├── references/
│   └── scripts/
├── scripts/                           # 콘텐츠 마이그레이션 및 Skill 설치 스크립트
├── tests/                             # 웹 문서 및 Skill 테스트
└── K8RVIS_최종발표자료_오타 수정.pdf   # 최종 발표 자료
```
