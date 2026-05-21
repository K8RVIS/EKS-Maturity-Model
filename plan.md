# EKS Maturity Advisor Skill 계획

## Summary
Quick Wins와 Foundational 항목을 기반으로 `eks-maturity-advisor` Codex Skill을 만든다. 원본은 `EKS-Maturity-Model/skills/eks-maturity-advisor`에 보관하고, 필요 시 Codex 설치 경로로 복사해 사용한다.

v1.2의 기본 목적은 **repo/manifest + live cluster read-only 진단**이다. 에이전트는 현재 상태를 보고 성숙도 gap, 위험도, 우선순위, 적용 가이드, 검증 방법을 제시한다. 실제 클러스터나 repo 변경은 수행하지 않는다.

## Key Changes
- Skill 구조:
  - `SKILL.md`: 진단 절차, 안전 경계, 출력 포맷, reference 선택 규칙.
  - `references/`: Quick Wins/Foundational 지식 파일을 phase/domain 단위로 분리.
  - `references/catalog.json`: 항목별 phase, domain, title, checks, source docs, remediation link.
  - `scripts/scan_eks_maturity.mjs`: repo와 live cluster를 read-only로 스캔해 JSON/Markdown 리포트 출력.
  - `agents/openai.yaml`: UI 표시 이름, 짧은 설명, 기본 프롬프트.
- 콘텐츠 원천:
  - `EKS-Maturity-Model/src/content/docs/quick-wins`
  - `EKS-Maturity-Model/src/content/docs/foundational`
  - `EKS-Maturity-Model/src/data/maturity-items.json`
- Scanner 범위:
  - Repo/manifest: ServiceAccount token, non-root/securityContext, Ingress TLS, ResourceQuota/LimitRange, hardcoded secret 의심 패턴.
  - Live cluster v1.2: Foundational 10개 항목 전체. private API endpoint, private nodegroup subnets, default deny NetworkPolicy, namespace PSS baseline, EKS Access Entries, Inspector triage, Grafana, EBS storage protection, workload secret 제거, RBAC 검증.
  - Live input 자동 감지: `--auto-detect` 사용 시 kubeconfig current context에서 EKS cluster name, region, kubectl context, AWS profile을 추론한다.
  - 출력은 `pass | warn | fail | unknown`, 관련 maturity 항목, severity, priority, 증거, 권장 조치, 검증 명령으로 통일.
- Skill 답변 정책:
  - 먼저 Quick Wins gap을 정리하고, 그다음 Foundational gap을 제시한다.
  - “바로 적용 가능한 항목”, “설계 결정이 필요한 항목”, “live 확인이 필요한 항목”으로 나눈다.
  - 명령은 기본적으로 조회/검증 명령만 실행 제안하고, 변경 명령은 명확히 “검토 후 적용”으로 표시한다.

## Public Interfaces
- Skill trigger 예시:
  - “이 EKS repo를 Quick Wins 기준으로 진단해줘”
  - “현재 클러스터가 Foundational 수준인지 확인해줘”
  - “이 매니페스트를 EKS 보안 성숙도 모델 기준으로 리뷰해줘”
- Scanner CLI:
  - `node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs --repo-root <path> --output markdown`
  - `node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs --live --context <kubectl-context> --cluster-name <name> --region <region> --output json`
  - `node skills/eks-maturity-advisor/scripts/scan_eks_maturity.mjs --live --auto-detect --output json`
- Report schema:
  - `item_id`, `phase`, `domain`, `status`, `severity`, `priority`, `evidence`, `recommendation`, `verify_commands`, `source_reference`.

## Test Plan
- Skill validation:
  - `quick_validate.py EKS-Maturity-Model/skills/eks-maturity-advisor`
  - YAML frontmatter, naming, required files, `agents/openai.yaml` 형식 검증.
- Scanner unit tests:
  - fixture manifest로 pass/fail/unknown 판정 테스트.
  - live mode는 `kubectl`/`aws` command runner를 mock 처리해 실제 클러스터 없이 검증.
- Content consistency:
  - Quick Wins와 Foundational의 `maturity-items.json` 항목이 `catalog.json`에 모두 포함되는지 확인.
  - reference 파일에 원천 문서 title/phase/domain이 누락되지 않는지 확인.
- Acceptance scenarios:
  - insecure baseline repo를 넣으면 Quick Wins gap이 우선순위와 함께 나온다.
  - 현재 `eks-secure-infra`처럼 일부 개선된 repo를 넣으면 적용된 항목은 pass, 남은 항목은 warn/fail로 분리된다.
  - live cluster 권한이나 도구가 없으면 실패하지 않고 `unknown`과 필요한 조회 명령을 출력한다.

## Assumptions
- v1.2 범위는 repo-only Quick Wins 5개와 live Foundational 10개를 포함한다.
- 원본 skill은 repo에 보관하고, Codex 직접 설치는 별도 후속 단계로 둔다.
- live cluster 지원은 read-only 진단만 허용한다.
- 자동 수정, `kubectl apply`, Terraform apply, 클러스터 변경은 v1.2 범위에서 제외한다.

## Feedback 반영 결정
- v1.2의 1차 타겟은 **Codex Skill**로 고정한다. GPTs, Assistants API, Claude Code 전용 배포는 v1.2 범위 밖으로 둔다.
- `agents/openai.yaml`은 GPT Action 설정이 아니라 Codex skill UI metadata로 사용한다.
- LLM은 scanner 결과를 단순 표시하지 않고, maturity 항목 매핑, 우선순위화, remediation 안내, 불확실성 설명을 담당한다.
- `catalog.json`은 수동 관리 파일이 아니라 기존 docs와 `maturity-items.json`에서 생성되는 artifact로 둔다.
- v1 scanner는 repo-only Quick Wins 5개 항목부터 구현했다. v1.1은 live cluster 진단과 Foundational 자동 스캔 5개 항목을 추가한다.
- v1.2에서 Grafana, Inspector triage, EBS workload storage protection, hardcoded secret 제거 심화, 상세 RBAC 검증과 kubeconfig 기반 live input 자동 감지를 추가한다.
- Codex skill packaging 검증은 `quick_validate.py`를 보조로 사용하고, repo CI에서는 자체 테스트를 우선한다.

## 배포 전략
- **Deployment는 문서 사이트 배포**에만 사용한다.
  - `main` push 또는 docs/content 변경 시 기존 Astro/Starlight GitHub Pages 파이프라인으로 정적 페이지를 배포한다.
  - 대상은 사람이 읽는 EKS Maturity Model 문서다.
- **Release는 skill 배포**에 사용한다.
  - `eks-maturity-advisor-v*` tag 생성 시 skill validation, scanner test, catalog consistency test를 실행한다.
  - `skills/eks-maturity-advisor`를 self-contained zip으로 패키징해 GitHub Release asset으로 업로드한다.
  - release asset에는 생성된 catalog/reference, scanner scripts, `SKILL.md`, `agents/openai.yaml`을 포함한다.
- 로컬 개발/검증 배포는 repo의 skill 폴더를 `${CODEX_HOME:-$HOME/.codex}/skills/eks-maturity-advisor`로 복사하는 설치 스크립트로 처리한다.
- 별도 repo 또는 marketplace 배포는 v1 사용성이 검증된 뒤 검토한다.

---

## Feedback

> 이 섹션은 계획 검토 과정에서 도출된 피드백이다. Codex와 재검토 시 반영 여부를 결정한다.

### 강점

- v1.2 범위 경계(repo-only Quick Wins + live Foundational 10개, read-only 진단, 자동 수정 제외)가 명확하다.
- 출력 스키마(`item_id / phase / domain / status / severity / evidence / recommendation / verify_commands / source_reference`)가 LLM 파싱과 사람이 읽는 리포트 양쪽에 적합하다.
- fixture manifest 기반 단위 테스트 + kubectl/aws mock 전략은 실제 클러스터 없이 CI가 돌아갈 수 있어 현실적이다.

### 지적 사항

#### 1. 타겟 플랫폼을 먼저 결정해야 한다

`SKILL.md`와 `agents/openai.yaml`이 계획서에 혼재한다.
"Codex Skill"이 **Claude Code custom skill**인지, **OpenAI GPTs Action**인지, **Assistants API**인지에 따라 구현 형태가 완전히 달라진다.

- Claude Code Skill → `SKILL.md`가 system prompt, `/eks-advisor` 트리거
- OpenAI GPTs → `agents/openai.yaml`이 GPT 설정, Actions로 API 연결

두 방향을 동시에 겨냥하면 어느 쪽도 제대로 동작하지 않는다. 하나를 먼저 선택한다.

#### 2. LLM의 역할이 설계되지 않았다

`scan_eks_maturity.mjs`가 진단 핵심이고 LLM은 결과를 "보여주는 UI"에 그친다면 "AI Agent"라고 부르기 어렵다. 다음 중 하나를 선택해야 한다.

| 방식 | 내용 | 복잡도 |
|---|---|---|
| **LLM이 도구를 직접 호출** | kubectl/aws를 도구로 받아 LLM이 직접 조회 후 판단 | 높음 |
| **LLM이 스캔 결과를 해석** | 스캐너 JSON → LLM이 우선순위·실행 가이드 생성 | 중간 |
| **LLM이 manifest를 직접 판단** | 사용자가 붙여넣은 YAML을 LLM이 maturity 기준으로 진단 | 낮음 |

v1에서는 셋 중 "LLM이 manifest를 직접 판단"이 가장 빠르게 구현 가능하다.

#### 3. `catalog.json`을 새로 만들면 동기화 부담이 생긴다

`maturity-items.json`이 이미 있고, 각 문서에 `## Assessment 체크리스트`와 `## 검증 방법` 섹션이 구조화되어 있다. 새 `catalog.json`을 수동으로 작성하면 docs와 json 두 곳을 동시에 관리해야 한다.

더 현실적인 방법: docs를 파싱해 checks/verify_commands를 추출하거나, `maturity-items.json`에 `checks`/`severity` 필드를 직접 추가한다.

```python
# 예시: 문서에서 체크리스트 자동 추출
import re, pathlib

def extract_checks(md_path):
    text = pathlib.Path(md_path).read_text()
    checks = re.findall(r'- \[ \] (.+)', text)
    verify_cmds = re.findall(r'```bash\n(kubectl [^\n]+)', text)
    return checks, verify_cmds
```

#### 4. v1 스캐너 범위를 줄여야 한다

계획서의 Scanner 범위(repo scan 10종 + live cluster 3종)는 v1에 비해 과대하다.
Quick Wins 7개도 체크 로직이 각각 다르므로, 다음 5개를 먼저 구현하고 나머지는 v1.1로 미룬다.

| 항목 | 체크 포인트 |
|---|---|
| non-root containers | `securityContext.runAsUser != 0`, `runAsNonRoot: true` |
| default ServiceAccount | `automountServiceAccountToken: false` |
| Ingress TLS | `spec.tls` 섹션 존재 여부 |
| ResourceQuota/LimitRange | 네임스페이스당 객체 존재 여부 |
| hardcoded secret 패턴 | `env[].value`에 password/secret/key 포함 정규식 |

#### 5. `quick_validate.py`의 출처를 명확히 해야 한다

`quick_validate.py EKS-Maturity-Model/skills/eks-maturity-advisor`가 Codex 내장 도구인지, 직접 작성해야 하는지 불명확하다. Codex 외부에서도 검증이 필요하다면 pytest로 대체한다.

### 권장 v1 구현 순서

1. **타겟 플랫폼 결정**: Claude Code Skill 또는 CLI + LLM 해석 레이어 중 하나 선택
2. **콘텐츠 추출 스크립트**: 기존 docs에서 checks/verify_commands 파싱 → catalog 생성
3. **Quick Wins 5개 스캐너**: repo-only 모드 먼저 구현 (kubeconfig 불필요)
4. **SKILL.md 또는 system prompt 작성**: 성숙도 지식 + 출력 형식 + 안전 경계
5. **fixture 기반 단위 테스트**
6. **live cluster 모드 추가 (v1.1)**
