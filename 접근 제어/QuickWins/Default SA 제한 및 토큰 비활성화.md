# Default ServiceAccount 사용을 제한하고 불필요한 토큰 마운트를 비활성화한다

> **Phase:** Quick Wins
>
> **보안 영역:** 접근 제어
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

## 왜 필요한가

Kubernetes에서 `ServiceAccount(SA)`는 Pod가 Kubernetes API 서버에 자신을 인증할 때 사용하는 워크로드용 계정이다. 사람 사용자가 로그인할 때 쓰는 IAM User나 Kubernetes 사용자와 달리, SA는 클러스터 안에서 실행되는 애플리케이션이 API 서버와 통신할 때 사용하는 신원이라고 이해하면 된다.

모든 네임스페이스에는 `default`라는 이름의 ServiceAccount가 자동으로 생성된다. Pod에 `serviceAccountName`을 명시하지 않으면 해당 Pod는 기본적으로 이 `default` SA를 사용한다. 또한 별도 설정이 없으면 ServiceAccount 토큰이 Pod 내부 `/var/run/secrets/kubernetes.io/serviceaccount` 경로에 자동 마운트된다.

이 기본 동작은 편리하지만, 보안 관점에서는 몇 가지 문제가 생긴다.

- 애플리케이션이 Kubernetes API를 전혀 사용하지 않아도 토큰이 Pod 안에 들어간다.
- 공격자가 웹 취약점이나 RCE를 통해 Pod 내부에 진입하면, 마운트된 토큰을 읽어 Kubernetes API 호출을 시도할 수 있다.
- `default` SA에 관리 편의를 이유로 추가 권한이 바인딩되어 있으면, 해당 네임스페이스의 모든 Pod가 같은 권한을 공유하는 구조가 된다.
- 모든 Pod가 default를 공유하면, 어떤 워크로드가 어떤 권한으로 API를 사용하는지 추적하기 어려워져 감사와 권한 리뷰가 어려워진다.

`default` SA 자체가 항상 강력한 권한을 가지는 것은 아니다. 일반적으로는 제한적인 discovery 수준의 기본 권한만 갖지만, 운영 과정에서 `RoleBinding`이나 `ClusterRoleBinding`이 추가되면 위험도가 급격히 높아진다. 해당 네임스페이스 내의 모든 파드가 그 권한을 공유하게 되기 때문이다.
따라서 보안적으로는 `default` SA를 워크로드 실행 계정으로 적극 사용하지 않고, 꼭 필요한 워크로드에만 전용 SA를 분리하는 것이 바람직하다.

EKS에서도 원칙은 같다. 특히 EKS는 IRSA나 Pod Identity처럼 워크로드별 권한 분리가 중요한 환경이므로, `default` SA를 계속 사용하면 Kubernetes의 RBAC 경계와 AWS의 IAM 보안 경계를 모호하게 만들어, '최소 권한 원칙'의 적용을 불가능하게 만들 수 있다.

현재 `eks-secure-infra` 실습 환경의 insecure baseline에서도 이 위험을 확인할 수 있다. [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/api/deployment.yaml)에는 아래와 같이 `api` 워크로드가 `default` SA와 자동 토큰 마운트를 사용하도록 설정되어 있다.

```yaml
spec:
  serviceAccountName: default
  automountServiceAccountToken: true
```

이 항목의 목표는 다음 두 가지다.

- `default` SA를 일반 워크로드 실행 계정으로 쓰지 않는다.
- Kubernetes API가 꼭 필요하지 않은 Pod에는 `automountServiceAccountToken: false`를 명시한다.

## 수행 방법

#### 사전 조건

- `kubectl`로 클러스터에 접근할 수 있어야 한다.
- 대상 워크로드가 실제로 Kubernetes API 호출이 필요한지 사전에 확인해야 한다.
- `eks-secure-infra`처럼 GitOps 또는 매니페스트 기반으로 관리하는 환경이라면, 라이브 패치보다 원본 매니페스트를 우선 수정해야 한다.

### Step 1: 현재 default SA 사용 현황을 확인한다

먼저 어떤 워크로드가 `default` SA를 사용하고 있는지 확인한다.

```bash
# team-d를 default namespace로 설정함
kubectl config set-context --current --namespace=<namespace명>

# namespace에서 사용하고 있는 sa 확인
kubectl get sa default -A

# 특정 워크로드가 어떤 ServiceAccount를 쓰는지 확인
kubectl get deploy api -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'

# 토큰 자동 마운트 여부 확인
kubectl get deploy api -n team-a -o jsonpath='{.spec.template.spec.automountServiceAccountToken}{"\n"}'
```

`serviceAccountName`이 비어 있거나 `default`라면 해당 워크로드는 기본 SA를 사용 중인 것이다.

### Step 2: 각 네임스페이스의 default SA에 자동 토큰 마운트를 비활성화한다

`default` SA는 남겨두되, 토큰을 자동으로 제공하지 않도록 설정한다.

```bash
kubectl patch serviceaccount default -n <namespace명> \
  -p '{"automountServiceAccountToken": false}'
```

매니페스트로 관리한다면 아래와 같이 선언할 수 있다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: <namespace명>
automountServiceAccountToken: false
```

이 설정은 "기본 계정은 있되, 아무 생각 없이 토큰을 받아 쓰지는 않게 하자"는 최소 안전장치다.

### Step 3: Kubernetes API가 필요 없는 워크로드는 전용 SA를 쓰더라도 토큰 마운트를 끈다

모든 워크로드에 반드시 권한이 있는 SA가 필요한 것은 아니다. 오히려 API 호출이 필요 없다면 전용 SA를 명시하고도 토큰 마운트는 끄는 편이 더 안전하다.

예를 들어 현재 `eks-secure-infra`의 `api`는 `ealen/echo-server` 기반의 샘플 워크로드이므로, 기본 상태에서는 Kubernetes API를 호출할 이유가 없다. 따라서 다음과 같이 바꿀 수 있다.

먼저 전용 ServiceAccount를 생성한다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-workload
  namespace: <namespace명>
automountServiceAccountToken: false
```

그리고 Deployment에서 `default` 대신 이 전용 SA를 명시하고, Pod 레벨에서도 토큰 자동 마운트를 끈다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: <namespace명>
spec:
  template:
    spec:
      serviceAccountName: api-workload
      automountServiceAccountToken: false
      containers:
        - name: api
          image: ealen/echo-server
```

`eks-secure-infra`의 현재 baseline을 기준으로 보면 아래와 같은 before/after로 이해할 수 있다.

```yaml
# Before
spec:
  serviceAccountName: default
  automountServiceAccountToken: true

# After
spec:
  serviceAccountName: api-workload
  automountServiceAccountToken: false
```

### Step 4: Kubernetes API 접근이 꼭 필요한 워크로드만 예외로 처리한다

일부 컨트롤러, 오퍼레이터, 배치 작업은 Kubernetes API를 직접 호출해야 하므로 ServiceAccount 토큰이 필요할 수 있다. 이 경우에도 `default` SA를 다시 사용하지 말고, Step 3처럼 워크로드 전용 SA를 만든 뒤 해당 워크로드에 한해서만 토큰 마운트를 허용한다.

RBAC는 이 항목의 핵심 적용 대상은 아니지만, 실제 운영에서는 API 호출에 필요한 최소 권한만 전용 SA에 별도로 부여해야 한다. 예를 들어 Pod 조회만 필요하면 `pods`에 대한 `get`, `list` 정도만 허용하고, Secret 조회나 리소스 수정 권한은 부여하지 않는다.

이 경우에도 핵심은 같다.

- `default` SA를 쓰지 않는다.
- 필요한 워크로드마다 전용 SA를 만든다.
- 토큰 마운트는 Kubernetes API 접근이 필요한 워크로드에만 허용한다.
- RBAC가 필요한 경우에는 별도 접근 제어 항목에 따라 최소 권한만 부여한다.

### Step 5: eks-secure-infra에 수동으로 반영한다

현재 저장소 기준으로는 [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/api/deployment.yaml)의 `api` Deployment를 먼저 수정하는 것이 가장 직접적인 적용 포인트다.

권장 반영 순서는 다음과 같다.

1. `team-*` 네임스페이스별로 `default` SA의 `automountServiceAccountToken: false`를 적용한다.
2. `api` 워크로드용 전용 SA 매니페스트를 추가한다.
3. `api` Deployment의 `serviceAccountName`을 `default`에서 `api-workload`로 변경한다.
4. `api` Deployment의 `automountServiceAccountToken`을 `true`에서 `false`로 변경한다.
5. 추후 실제 API 호출이 필요한 기능이 생길 때만 해당 워크로드에 최소 권한 RBAC와 토큰 마운트를 다시 허용한다.

**자동화의 경우, 추후 '(optimized) 자동화를 통한 정책 접근 제어' 항목에서 다룰 예정이다.**

## 검증 방법

```bash
# 1) default SA 자동 마운트 비활성화 여부 확인
kubectl get sa default -n team-a -o jsonpath='{.automountServiceAccountToken}{"\n"}'

# 2) Deployment가 default SA를 계속 쓰는지 확인
kubectl get deploy api -n team-a -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'

# 3) Pod 레벨 자동 마운트 설정 확인
kubectl get deploy api -n team-a -o jsonpath='{.spec.template.spec.automountServiceAccountToken}{"\n"}'

# 4) Pod 내부에 토큰 경로가 실제로 비어 있는지 확인
kubectl exec -n team-a deploy/api -- ls /var/run/secrets/kubernetes.io/serviceaccount
```

기대 결과는 다음과 같다.

- `default` SA의 `automountServiceAccountToken` 값이 `false`다.
- `api` Deployment의 `serviceAccountName`이 `default`가 아니라 전용 SA 이름이다.
- `api` Deployment의 `automountServiceAccountToken` 값이 `false`다.
- Pod 내부에서 `token` 파일이 보이지 않거나, 경로 접근이 실패한다.

비교 검증을 하려면 적용 전후를 나란히 보면 된다.

- 미적용 상태: `serviceAccountName: default`, `automountServiceAccountToken: true`
- 적용 상태: `serviceAccountName: api-workload`, `automountServiceAccountToken: false`

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 애플리케이션 취약점을 통해 `api` Pod 안에서 쉘을 획득한 뒤, 자동 마운트된 ServiceAccount 토큰을 읽어 Kubernetes API를 호출한다.
- **영향 범위:** 네임스페이스 내 리소스 조회, RBAC 설정에 따라 Secret 열람, 워크로드 정보 수집, 추가 횡이동 시도까지 이어질 수 있다.
- **심각도:** **중간~높음**. 기본 `default` SA 자체는 제한적일 수 있지만, 잘못된 RoleBinding이나 ClusterRoleBinding이 추가된 환경에서는 피해가 빠르게 커질 수 있다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부 및 예상 규모:** 없음
- **오픈소스 vs 상용 도구 선택 시 비용 차이:** 없음. Kubernetes 기본 기능과 매니페스트 수정만으로 적용 가능

## 참고 자료

- [AWS EKS Best Practices - Identity and Access Management](https://aws.github.io/aws-eks-best-practices/security/docs/iam/)
- [Kubernetes - Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [CIS Amazon EKS Benchmark v1.8.0](<./CIS_Amazon_Elastic_Kubernetes_Service_(EKS)_v.1.8.0_PDF.md>)
- [CIS Kubernetes Benchmark v1.12.0](./CIS_Kubernetes_Benchmark_V1.12.0_PDF.md)
- [NSA/CISA Kubernetes Hardening Guidance](./CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.md)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Amazon EKS Benchmark v1.8.0**
  `4.1.5 Ensure that default service accounts are not actively used`
  `default` SA를 워크로드 실행 계정으로 계속 사용하지 말고, API 접근이 필요한 워크로드에는 전용 SA를 만들도록 권고한다.
- **CIS Amazon EKS Benchmark v1.8.0**
  `4.1.6 Ensure that Service Account Tokens are only mounted where necessary`
  Pod가 실제로 API 서버와 통신해야 하는 경우에만 토큰을 마운트하고, 그렇지 않으면 `automountServiceAccountToken: false`를 적용하도록 권고한다.
- **CIS Amazon EKS Benchmark v1.8.0**
  `4.1.12 Minimize access to the service account token creation`
  토큰을 새로 발급하거나 생성할 수 있는 권한 자체도 최소화해야 하므로, SA 운영은 생성 권한 관리와 함께 봐야 한다.
- **CIS Amazon EKS Benchmark v1.8.0**
  `4.5.2 The default namespace should not be used`
  `default` SA를 줄이는 작업은 결국 `default` 네임스페이스 의존도를 낮추는 운영 원칙과도 연결된다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.5 Ensure that default service accounts are not actively used`
  Kubernetes 일반 기준에서도 `default` SA에 비기본 권한을 부여하지 말고, 전용 SA를 분리하도록 요구한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.6 Ensure that Service Account Tokens are only mounted where necessary`
  토큰 자동 마운트는 필요한 Pod에만 허용해야 하며, 불필요한 토큰 노출은 privilege escalation 경로가 될 수 있다고 본다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.13 Minimize access to the service account token creation`
  SA 토큰 생성 권한을 가진 주체가 많을수록 우회 경로가 늘어나므로, 운영자 권한과 자동화 계정 권한도 함께 검토해야 한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.6.4 The default namespace should not be used`
  실무에서는 `default` 네임스페이스와 `default` SA 사용이 함께 굳어지는 경우가 많아, 두 항목을 같이 관리하는 편이 효과적이다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `Protecting Pod service account tokens`
  많은 애플리케이션은 ServiceAccount에 직접 접근할 필요가 없으며, 애플리케이션이 침해되면 Pod 내부 토큰이 공격자에게 탈취될 수 있으므로 `automountServiceAccountToken: false`를 사용하라고 권고한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `Authentication and Authorization / ServiceAccount Admission Controller`
  Pod 정의에 SA를 지정하지 않으면 admission 단계에서 `default` SA가 자동 연결될 수 있으므로, 워크로드 정의에서 SA와 토큰 정책을 명시적으로 선언해야 한다는 배경 근거가 된다.

## Assessment 체크리스트

- [ ] `default` ServiceAccount에 `automountServiceAccountToken: false`가 설정되어 있는가?
- [ ] 일반 애플리케이션 워크로드가 `default` ServiceAccount를 직접 사용하지 않는가?
- [ ] Kubernetes API 접근이 필요한 워크로드만 전용 ServiceAccount를 사용하고 있는가?
- [ ] API 접근이 필요 없는 워크로드에는 `automountServiceAccountToken: false`가 적용되어 있는가?
- [ ] `eks-secure-infra`의 `api` 워크로드가 `default` SA 대신 전용 SA를 사용하도록 수정되었는가?

#### 대규모 환경을 위한 patch 자동화 방안

관리해야 할 리소스가 수백 개 이상인 대규모 클러스터 환경에서는 사람이 일일이 매니페스트를 수정하기 어렵고 누락이 발생할 위험이 크다.

이를 보완하기 위해, **현재 클러스터 내에서 여전히 default SA를 사용 중인 리소스를 자동으로 식별하고 패치를 생성하는 스크립트 기반의 접근 방식을 병행**하여 사용할 수 있다.

**자동화 스크립트의 작동 원리 및 특징**

- **렌더링 결과 기반 탐색**: kustomization.yaml의 실제 렌더링 결과(Overlay)를 기준으로 리소스를 분석한다.

- **타겟팅 패치**: 이미 전용 SA를 명시하여 사용 중인 워크로드(의도적으로 권한을 부여한 대상)는 제외하고, 명시적 설정이 없어 K8s 기본 동작에 의해 default SA가 할당된 리소스만 선별하여 패치 대상으로 선정한다.

- **Kustomize 연동**: 식별된 대상에 대해서만 automountServiceAccountToken: false를 적용하는 default-sa-token-patch.yaml을 동적으로 생성하여, Kustomize 파이프라인에 자동으로 포함시킨다.
