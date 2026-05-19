# Container Image 정책을 관리한다

> **Phase:** Optimized
>
> **보안 영역:** Pod 보안
>
> **담당:** 장해윤
>
> **난이도:** ★★★

---

## 왜 필요한가

**Container Image 스캔 및 차단**(ECR + Inspector)과 **컨테이너 이미지 취약점 판단 및 관리**(EventBridge + SNS 알림)는 취약점을 탐지하고 담당자에게 알리는 역할을 한다. 하지만 두 단계 모두 **레지스트리와 알림 수준에서 동작**하기 때문에, 취약한 이미지가 Kubernetes에 실제로 배포되는 것을 직접 막지는 못한다.

또한 Quick Wins 단계에서 수동으로 적용한 securityContext 보안 설정(컨테이너 root 실행 제한, 읽기 전용 파일시스템 등)은 설정 누락 또는 실수로 인해 정책이 지켜지지 않을 수 있다.

Kyverno는 Kubernetes Admission Controller로 동작하여 두 가지 문제를 해결한다.

- **자동 차단 (Enforce):** 정책을 위반하는 Pod는 API 서버 수준에서 거부된다.
- **자동 주입 (Mutate):** securityContext 설정이 누락된 Pod에 기본값을 자동으로 삽입한다.

### 앞 단계 정책과의 연결

이 단계의 핵심 목적은 **Quick Wins ~ Efficient 단계에서 수동으로 적용했던 정책을 Kyverno를 통해 자동으로 강제하는 것**이다.

| Kyverno 정책 | 연결 단계 | 역할 |
| --- | --- | --- |
| `01-require-registry` | Container Image 스캔 및 차단 | Inspector가 스캔하는 ECR 외 레지스트리 이미지를 입장 시점에 차단 |
| `02-require-security-context` | Quick Wins (컨테이너 보안 설정 수동 적용) | 수동으로 설정하던 securityContext 항목을 정책으로 자동 강제 |
| `03-mutate-default-securitycontext` | Quick Wins (기본값 설정) | securityContext 누락 시 안전한 기본값을 자동 주입 |
| `04-require-image-tag` | 컨테이너 이미지 취약점 판단 및 관리 | Inspector가 특정 버전 태그 기준으로 스캔하므로 `:latest` 및 태그 없는 이미지 차단 |

---

## 수행 방법

**사전 조건**

- Kyverno가 클러스터에 설치되어 있어야 한다.
- **Container Image 스캔 및 차단**(ECR + Inspector), **컨테이너 이미지 취약점 판단 및 관리**(EventBridge + SNS)가 구성되어 있어야 한다.
- 배포할 이미지가 ECR에 push되어 있어야 한다.

### Step 1: Kyverno 설치 상태를 확인한다

```bash
kubectl get pods -n kyverno
kubectl get crd | grep kyverno
```

기대 결과: kyverno Pod가 `Running` 상태이고, `clusterpolicies.kyverno.io` CRD가 등록되어 있다.

### Step 2: ECR 전용 레지스트리 정책을 적용한다 (01-require-registry)

Docker Hub 등 공용 레지스트리 이미지를 차단하고 ECR 이미지만 허용한다. **Container Image 스캔 및 차단** 단계에서 구성한 ECR 레지스트리를 Kubernetes 입장 시점에서도 강제한다.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-private-registry
  namespace: kyverno
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: validate-registry
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "Private ECR registry만 허용됩니다. Public registry 이미지는 사용할 수 없습니다."
      anyPattern:
      - spec:
          containers:
          - image: "*.dkr.ecr.*.amazonaws.com/*"
      - spec:
          containers:
          - image: "*.dkr.ecr.*.amazonaws.com.cn/*"
```

### Step 3: securityContext 강제 정책을 적용한다 (02-require-security-context)

Quick Wins 단계에서 수동으로 설정하던 4가지 보안 항목을 정책으로 강제한다. 설정이 누락된 Pod는 배포가 거부된다.

| 강제 항목 | 설명 | Quick Wins 연결 |
| --- | --- | --- |
| `runAsNonRoot: true` | root 사용자 실행 금지 | 컨테이너 root 실행 제한 |
| `readOnlyRootFilesystem: true` | 루트 파일시스템 읽기 전용 | 파일시스템 쓰기 제한 |
| `allowPrivilegeEscalation: false` | 권한 상승 금지 | 권한 상승 제한 |
| `capabilities.drop: ALL` | Linux capability 전체 제거 | 최소 권한 원칙 |

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-security-context
  namespace: kyverno
spec:
  validationFailureAction: enforce
  background: true
  rules:
  - name: validate-runAsNonRoot
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "runAsNonRoot: true 설정이 필수입니다."
      pattern:
        spec:
          securityContext:
            runAsNonRoot: true
  - name: validate-readOnlyRootFilesystem
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "readOnlyRootFilesystem: true 설정이 필수입니다. /tmp는 emptyDir로 마운트하세요."
      pattern:
        spec:
          containers:
          - securityContext:
              readOnlyRootFilesystem: true
  - name: validate-allowPrivilegeEscalation
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "allowPrivilegeEscalation: false 설정이 필수입니다."
      pattern:
        spec:
          containers:
          - securityContext:
              allowPrivilegeEscalation: false
  - name: validate-capabilities
    match:
      resources:
        kinds:
        - Pod
    validate:
      message: "모든 Linux capabilities를 제거해야 합니다 (capabilities.drop: ALL)."
      pattern:
        spec:
          containers:
          - securityContext:
              capabilities:
                drop:
                - ALL
```

### Step 4: securityContext 자동 주입 정책을 적용한다 (03-mutate-default-securitycontext)

securityContext 설정이 누락된 Pod에 안전한 기본값을 자동으로 삽입한다. `Audit` 모드로 동작하여 차단하지 않고 자동 수정한다.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-securitycontext
  namespace: kyverno
spec:
  validationFailureAction: audit
  background: true
  rules:
  - name: mutate-pod-securitycontext
    match:
      resources:
        kinds:
        - Pod
    mutate:
      patchStrategicMerge:
        spec:
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            runAsGroup: 65534
            fsGroup: 65534
            seccompProfile:
              type: RuntimeDefault
  - name: mutate-container-securitycontext
    match:
      resources:
        kinds:
        - Pod
    mutate:
      patchStrategicMerge:
        spec:
          containers:
          - (name): "*"
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              runAsNonRoot: true
              runAsUser: 65534
              runAsGroup: 65534
              capabilities:
                drop:
                - ALL
```

### Step 5: 이미지 태그 강제 정책을 적용한다 (04-require-image-tag)

`:latest` 또는 태그 없는 이미지를 차단한다. Amazon Inspector v2는 특정 버전 태그를 기준으로 스캔하므로, **컨테이너 이미지 취약점 판단 및 관리** 단계에서 Inspector가 검증한 특정 버전만 배포 가능하도록 강제한다. ECR의 `IMMUTABLE` 태그 설정과 함께 이미지 무결성을 보장한다.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-tag
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: require-non-latest-tag
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >
          이미지 태그를 명시해야 하며 'latest'는 허용되지 않습니다.
          AWS Inspector v2는 특정 버전 태그를 기준으로 스캔합니다.
          IMMUTABLE 태그가 설정된 ECR의 검증된 버전을 사용하세요.
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.image }}"
                    operator: Equals
                    value: "*:latest"
                  - key: "{{ element.image }}"
                    operator: NotContains
                    value: ":"
```

---

## 검증 방법

적용된 ClusterPolicy 목록과 상태를 확인한다.

```bash
kubectl get clusterpolicy
```

기대 결과: 4개 정책이 모두 `READY` 상태로 표시된다.

각 정책의 상세 상태를 확인한다.

```bash
kubectl describe clusterpolicy require-private-registry
kubectl describe clusterpolicy require-security-context
kubectl describe clusterpolicy add-default-securitycontext
kubectl describe clusterpolicy require-image-tag
```

공용 레지스트리 이미지 차단을 테스트한다.

```bash
kubectl run test-public \
  --image=nginx:1.25 \
  --dry-run=server \
  -o yaml
```

기대 결과: `Private ECR registry만 허용됩니다` 메시지와 함께 거부된다.

`:latest` 태그 차단을 테스트한다.

```bash
kubectl run test-latest \
  --image=<AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-2.amazonaws.com/eks-secure-infra/web:latest \
  --dry-run=server \
  -o yaml
```

기대 결과: `이미지 태그를 명시해야 하며 'latest'는 허용되지 않습니다` 메시지와 함께 거부된다.

Audit 모드 정책 위반 기록을 확인한다.

```bash
kubectl get policyreport -A
kubectl get clusterpolicyreport
```

**검증 완료 기준**

- 4개 ClusterPolicy가 모두 `READY` 상태이다.
- 공용 레지스트리 이미지(Docker Hub 등) 배포가 거부된다.
- `:latest` 태그 이미지 배포가 거부된다.
- ECR 이미지 + 특정 버전 태그 조합은 정상 배포된다.
- securityContext 누락 Pod에 기본값이 자동 주입된다.

---

## Risk 및 미적용 시 영향

- **정책 우회 가능:** **Container Image 스캔 및 차단** ~ **컨테이너 이미지 취약점 판단 및 관리** 단계가 구성되어 있어도 Kyverno 없이는 개발자가 실수 또는 의도적으로 공용 레지스트리 이미지나 `:latest` 태그 이미지를 배포할 수 있다.
- **securityContext 누락:** 수동으로 설정한 보안 정책은 새 배포 시 누락되기 쉽다. Kyverno 없이는 누락 여부를 배포 후에야 인지한다.
- **Inspector 검증 우회:** `:latest` 허용 시 Inspector가 스캔하지 않은 버전이 배포될 수 있어 **Container Image 스캔 및 차단** ~ **컨테이너 이미지 취약점 판단 및 관리** 단계의 스캔 효과가 무력화된다.
- **심각도:** **높음**. Admission Controller 수준의 차단이 없으면 앞 단계(Quick Wins)에서 쌓은 보안 체계가 배포 시점에 무력화될 수 있다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 플랫폼/DevSecOps 담당자 (정책 설계 및 예외 관리) |
| AWS 추가 비용 | 없음 (Kyverno는 오픈소스, 클러스터 내 실행) |
| 운영 고려사항 | 정책 적용 초기에는 기존 워크로드가 차단될 수 있다. `Audit` 모드로 먼저 적용해 위반 항목을 파악한 뒤 `Enforce`로 전환하는 것을 권장한다. |

---

## Assessment 체크리스트

- [ ] 4개 ClusterPolicy가 모두 `READY` 상태인가?
- [ ] 공용 레지스트리(Docker Hub 등) 이미지 배포가 차단되는가?
- [ ] `:latest` 태그 이미지 배포가 차단되는가?
- [ ] securityContext 누락 Pod에 기본값이 자동 주입되는가?
- [ ] `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: ALL` 미설정 Pod가 거부되는가?
- [ ] PolicyReport에서 정책 위반 내역을 조회할 수 있는가?

---

## 참고 자료

- [Kyverno - ClusterPolicy](https://kyverno.io/docs/kyverno-policies/)
- [Kyverno - Admission Controller](https://kyverno.io/docs/introduction/)
- [Kyverno - Mutate Rules](https://kyverno.io/docs/writing-policies/mutate/)
- [Amazon Inspector - Image tag and scanning](https://docs.aws.amazon.com/inspector/latest/user/scanning-ecr.html)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  Admission Controller를 사용해 보안 정책을 클러스터 수준에서 강제하도록 권고하며, 컨테이너 root 실행 및 권한 상승을 제한하는 정책을 포함한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  Admission Controller를 통한 정책 강제를 권고하며, 검증된 레지스트리의 이미지만 사용하고 컨테이너 보안 설정을 표준화하도록 요구한다.
- **AWS EKS Best Practices**
  Kyverno와 같은 Policy Controller를 사용해 이미지 출처 제한, securityContext 강제, 태그 정책 적용을 자동화하도록 권장한다.
