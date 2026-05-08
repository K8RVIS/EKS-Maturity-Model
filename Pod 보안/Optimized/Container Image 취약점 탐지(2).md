# Kyverno로 Private ECR Registry 이미지만 허용하고 securityContext를 강제한다

> **Phase:** Optimized
>
> **보안 영역:** Pod 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★★★

---

> **연계 항목:** 이 문서는 [Foundational — Container Image 취약점 탐지]()의 연장선이다. Foundational 단계에서 ECR 향상된 스캔과 Amazon Inspector로 이미지 취약점 탐지 체계를 갖춘 뒤, 이 단계에서는 Kyverno로 이미지 출처와 컨테이너 실행 권한을 Admission Controller 수준에서 정책으로 강제한다.

#### 왜 필요한가

컨테이너 이미지의 출처를 통제하지 않으면 누구든 Docker Hub, GitHub Container Registry 등 검증되지 않은 외부 레지스트리의 이미지를 클러스터에 배포할 수 있다. 외부 이미지는 변조 여부를 확인할 수 없고, 악성 코드나 백도어가 포함되어 있을 수 있다.

securityContext를 강제하지 않으면 컨테이너가 root 권한으로 실행되거나, 파일시스템 쓰기가 허용된 상태로 배포된다. 이 경우 컨테이너가 침해되면 공격자가 호스트 시스템에 접근하거나 런타임 파일을 수정할 수 있다.

Kyverno는 Kubernetes Admission Controller 기반의 정책 엔진이다. 파드가 생성되는 시점에 요청을 가로채 정책 위반 여부를 검사하고, 위반 시 요청 자체를 거부한다. 별도의 사이드카나 에이전트 없이 ClusterPolicy 리소스만으로 클러스터 전체에 정책을 적용할 수 있다.

세 가지 정책 레이어로 이미지 출처와 실행 권한을 통제한다.

- **출처 통제:** Private ECR 레지스트리 이미지만 허용, 공용 레지스트리 이미지 거부
- **실행 권한 강제:** runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation 설정 검증
- **기본값 자동 주입:** securityContext 미설정 파드에 안전한 기본값 자동 적용

#### 수행 방법

**사전 조건**

- 클러스터에 Kyverno가 설치되어 있어야 한다.
- ECR Private Registry에 이미지가 올라가 있어야 한다.
- `kubectl`로 ClusterPolicy 리소스를 적용할 권한이 있어야 한다.

**Step 1: 현황을 파악한다**

적용 전에 공용 레지스트리 이미지로 파드 생성이 가능한지 확인한다.

```bash
kubectl run test-public --image=nginx:latest -n <NAMESPACE>
```

기대 결과(적용 전): 파드 생성 성공 → 이미지 출처 통제 없음, 취약

현재 클러스터에 Kyverno가 설치되어 있는지 확인한다.

```bash
kubectl get pods -n kyverno
kubectl get clusterpolicy
```

Kyverno가 없으면 설치한다.

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm install kyverno kyverno/kyverno -n kyverno --create-namespace
```

**Step 2: Private Registry 강제 정책을 적용한다**

ECR 주소(`*.dkr.ecr.*.amazonaws.com/*`)가 아닌 이미지는 파드 생성 시점에 거부하는 정책을 적용한다.

```yaml
# manifests/base/kyverno/01-require-registry.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-private-registry
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
```

`validationFailureAction: Enforce`는 위반 시 요청을 거부한다. `Audit`으로 설정하면 거부 없이 감사 로그만 남긴다. 처음 적용 시에는 `Audit`으로 기존 워크로드 영향을 먼저 확인하고 `Enforce`로 전환하는 것을 권장한다.

**Step 3: securityContext 강제 정책을 적용한다**

runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation, capabilities.drop 설정이 없는 파드를 거부하는 정책을 적용한다.

```yaml
# manifests/base/kyverno/02-require-security-context.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-security-context
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

**Step 4: securityContext 기본값 자동 주입 정책을 적용한다**

securityContext가 명시되지 않은 파드에 안전한 기본값을 자동으로 주입하는 Mutating 정책을 적용한다. Enforce 정책과 함께 사용하면 기존 워크로드가 정책 위반으로 거부되는 것을 방지할 수 있다.

```yaml
# manifests/base/kyverno/03-mutate-default-securitycontext.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-securitycontext
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

**Step 5: Kustomize로 정책을 배포한다**

```bash
kubectl apply -k manifests/overlays/<NAMESPACE>
kubectl get clusterpolicy
```

정책 3개가 모두 `READY` 상태인지 확인한다.

```bash
kubectl get clusterpolicy
```

기대 결과:

```
NAME                        ADMISSION   BACKGROUND   READY   AGE
require-private-registry    true        true         True    1m
require-security-context    true        true         True    1m
add-default-securitycontext true        true         True    1m
```

#### 검증 방법

**공용 이미지 차단 확인**

Kyverno 정책 적용 후 공용 레지스트리 이미지로 파드 생성을 시도한다.

```bash
kubectl run test-public --image=nginx:latest -n <NAMESPACE>
```

기대 결과:

```
Error from server: admission webhook "validate.kyverno.svc-fail" denied the request:
resource Pod was blocked due to the following policies
require-private-registry:
  validate-registry: Private ECR registry만 허용됩니다. Public registry 이미지는 사용할 수 없습니다.
```

**securityContext 미설정 파드 차단 확인**

```bash
kubectl run test-no-security --image=<ECR-URI>/myapp:latest \
  --overrides='{"spec":{"containers":[{"name":"test","image":"<ECR-URI>/myapp:latest"}]}}' \
  -n <NAMESPACE>
```

기대 결과: `require-security-context` 정책 위반으로 거부

**ECR 이미지 정상 배포 확인**

```bash
kubectl run test-ecr --image=<ECR-URI>/myapp:latest -n <NAMESPACE>
```

기대 결과: securityContext 설정이 포함된 경우 파드 생성 성공

**정책 위반 이벤트 확인**

```bash
kubectl get policyreport -n <NAMESPACE>
kubectl describe policyreport -n <NAMESPACE>
```

검증 완료 기준은 다음과 같다.

- 공용 레지스트리 이미지 사용 시 파드 생성이 거부된다.
- ECR 이미지 + 올바른 securityContext 설정 시 파드가 정상 생성된다.
- securityContext 미설정 파드에 기본값이 자동으로 주입된다.
- `kubectl get clusterpolicy`에서 3개 정책이 모두 `READY: True`로 표시된다.

#### Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 개발자가 편의를 위해 Docker Hub의 `ubuntu:latest` 이미지를 배포한다. 해당 이미지에 알려진 RCE 취약점이 포함되어 있어 공격자가 Pod 내부에서 명령을 실행하고 서비스 계정 토큰으로 클러스터 내부를 정찰한다.
- **권한 탈취 시나리오:** root로 실행 중인 컨테이너가 침해되면 공격자가 호스트 파일시스템에 접근하거나 다른 컨테이너의 데이터를 읽을 수 있다. `readOnlyRootFilesystem`이 설정되지 않은 경우 런타임 바이너리 교체도 가능하다.
- **운영 리스크:** Kyverno 없이 securityContext를 팀 규칙으로만 강제하면 실수나 누락이 발생한다. 정책 엔진은 배포 시점에 자동으로 검사하므로 인적 오류를 방지한다.
- **영향 범위:** 검증되지 않은 이미지 실행, root 권한 컨테이너로 인한 호스트 침해, 파일시스템 변조, 내부 네트워크 정찰
- **심각도:** **높음**. 이미지 출처 통제와 실행 권한 강제는 컨테이너 보안의 가장 기본적인 통제 수단이다.

#### 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼/DevSecOps 담당자 |
| AWS 추가 비용 | 없음 (Kyverno는 오픈소스) |
| 도구 비용 | Kyverno는 오픈소스. 상용 정책 관리 도구 도입 시 별도 비용 발생 |
| 운영 고려사항 | 기존 워크로드가 Enforce 정책에 의해 거부될 수 있으므로 Audit 모드로 먼저 검증 후 Enforce로 전환한다. kube-system, kyverno 네임스페이스는 정책 적용 대상에서 제외하는 것을 권장한다. |

#### 참고 자료

- [Kyverno 공식 문서](https://kyverno.io/docs/)
- [Kyverno - Validate Resources](https://kyverno.io/docs/writing-policies/validate/)
- [Kyverno - Mutate Resources](https://kyverno.io/docs/writing-policies/mutate/)
- [Kyverno - ClusterPolicy](https://kyverno.io/docs/kyverno-policies/)
- [AWS ECR Private Registry](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Registries.html)
- [CIS Kubernetes Benchmark v1.12.0](../CIS_Kubernetes_Benchmark_V1.12.0_PDF.md)
- [NSA/CISA Kubernetes Hardening Guidance](../CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.md)

#### 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  컨테이너는 root가 아닌 사용자로 실행해야 하며, 불필요한 Linux capabilities를 제거해야 한다. 이미지 출처를 신뢰할 수 있는 레지스트리로 제한하는 것을 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너는 최소 권한으로 실행하고, 불필요한 권한 상승을 방지해야 한다. 신뢰할 수 있는 레지스트리의 이미지만 사용하도록 권고한다.
- **AWS EKS Best Practices**
  Pod Security Standards와 Admission Controller를 활용해 워크로드의 실행 권한을 통제하고, ECR Private Registry를 통해 이미지 출처를 관리하는 것을 권장한다.

#### Assessment 체크리스트

- [ ] Kyverno 정책 3개(`require-private-registry`, `require-security-context`, `add-default-securitycontext`)가 모두 `READY: True` 상태인가?
- [ ] 공용 레지스트리 이미지 사용 시 파드 생성이 거부되는가?
- [ ] securityContext 미설정 파드 생성이 거부되는가?
- [ ] `kubectl get policyreport`로 정책 위반 현황을 정기적으로 확인하는가?
