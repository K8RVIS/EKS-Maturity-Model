---
title: "네임스페이스 내 리소스 접근 제어를 위한 RBAC 정의 및 검증을 수행한다"
description: "RBAC(Role-Based Access Control)는 Kubernetes 클러스터 내부의 사용자, 그룹, ServiceAccount, Pod가 Kubernetes 리소스에 대해 어떤 작업을 수행할 수 있는지 정의하는 권한 제어 체계이다."
phase: "Foundational"
domain: "접근 제어"
difficulty: "미정"
owner: "공통 (전체 실습)"
order: 10
sidebar:
  order: 10
---

## 왜 필요한가

RBAC(Role-Based Access Control)는 Kubernetes 클러스터 내부의 사용자, 그룹, ServiceAccount, Pod가 Kubernetes 리소스에 대해 어떤 작업을 수행할 수 있는지 정의하는 권한 제어 체계이다.

Kubernetes API는 Pod 조회, Secret 조회, Deployment 수정, ServiceAccount 사용 등 거의 모든 작업을 API 권한으로 통제한다. 따라서 RBAC가 과도하게 열려 있으면 단순 조회 권한이 민감 정보 노출로 이어지거나, 특정 네임스페이스의 권한이 클러스터 전체 권한 상승으로 확장될 수 있다.

네임스페이스 단위의 Role과 RoleBinding을 사용하면 특정 네임스페이스 안에서 필요한 리소스와 동작만 허용할 수 있다. 예를 들어 특정 네임스페이스에서 Pod 목록만 조회해야 하는 사용자나 애플리케이션에는 Pod 읽기 권한만 부여하고, Deployment 수정이나 Secret 조회 권한은 부여하지 않는다.

**이번 항목의 목표는 최소권한 원칙에 따라 네임스페이스 전용 Role과 RoleBinding을 정의하고, 권한이 의도한 범위 안에서만 동작하는지 검증하는 것이다.**

- **보안 강화:** 사용자와 ServiceAccount별 권한을 분리하여 보안 사고 발생 시 피해 범위를 최소화한다.
- **공격 방어:** 권한 상승과 횡적 이동을 차단하여 클러스터 전체 시스템을 보호한다.
- **운영 안정성:** 네임스페이스별 책임 범위를 명확히 하여 실수로 인한 리소스 변경을 줄인다.

## Scope

이번 이슈에 포함할 작업:

- 네임스페이스 전용 Role 생성
- 특정 사용자 또는 ServiceAccount를 위한 RoleBinding 설정
- 권한 정상 작동 여부 검증
- 클러스터 전체 단위의 ClusterRole 및 ClusterRoleBinding 적용 범위 이해

## 수행 방법

아래 절차는 현재 저장소의 Kustomize 매니페스트 반영 방식과 `kubectl` CLI 수동 적용 예시를 함께 설명한다. 운영 반영은 `eks-secure-infra/manifests/overlays/[namespace명]` 아래의 `*-rbac.yaml`과 `kustomization.yaml` 수정을 기준으로 하고, CLI 명령은 동일한 리소스를 수동으로 생성하거나 검증할 때 사용한다.

### 사전 조건

- 실습 대상 EKS 클러스터에 `kubectl`로 접근할 수 있어야 한다.
- RBAC 리소스를 생성할 수 있는 관리자 권한이 필요하다.
- 사용자 기반 검증을 수행하려면 AWS IAM 인증과 Kubernetes 사용자 매핑(AWS Access Entry 또는 AWS Auth configmap)이 선행되어야 한다.

### Step 1: 실습 네임스페이스를 생성한다

네임스페이스 단위 권한을 검증하기 위해 네임스페이스를 생성한다.

```bash
kubectl create namespace [namespace명]
```

이미 네임스페이스가 존재하는 경우 다음 명령으로 확인한다.

```bash
kubectl get namespace [namespace명]
```

### Step 2: 테스트용 ServiceAccount를 생성한다

Pod나 애플리케이션에 부여할 권한을 검증하기 위해 ServiceAccount를 생성한다.

현재 `eks-secure-infra` 저장소에서는 워크로드별 전용 ServiceAccount를 오버레이에 이미 분리해 두고 있다. RBAC는 이 전용 ServiceAccount를 대상으로 연결한다.

| 오버레이 예시                                                               | ServiceAccount |
| --------------------------------------------------------------------------- | -------------- |
| `eks-secure-infra/manifests/overlays/[namespace명]/api-serviceaccount.yaml` | `api-workload` |
| `eks-secure-infra/manifests/overlays/[namespace명]/web-serviceaccount.yaml` | `web-workload` |
| `eks-secure-infra/manifests/overlays/[namespace명]/db-serviceaccount.yaml`  | `db-workload`  |

CLI로 수동 생성하는 경우에는 다음과 같이 작성한다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: [serviceAccount명]
  namespace: [namespace명]
```

적용한다.

```bash
kubectl apply -f [파일명].yaml
```

ServiceAccount가 생성되었는지 확인한다.

```bash
kubectl get serviceaccount [serviceAccount명] -n [namespace명]
```

### Step 3: 네임스페이스 전용 Role을 생성한다

특정 네임스페이스 안에서 Pod 리소스만 읽을 수 있는 Role을 생성한다.

현재 저장소에서는 워크로드 성격에 맞춰 `*-rbac.yaml` 파일 안에 Role을 정의한다. 대표 구성은 다음과 같다.

| 파일            | Role               | 허용 리소스           | 허용 동작                        |
| --------------- | ------------------ | --------------------- | -------------------------------- |
| `api-rbac.yaml` | `api-manager`      | `deployments`, `pods` | `patch`, `update`, `get`, `list` |
| `web-rbac.yaml` | `web-pod-reader`   | `pods`                | `get`, `list`, `watch`           |
| `db-rbac.yaml`  | `db-secret-reader` | `secrets`             | `get`                            |

예를 들어 `web-rbac.yaml`은 다음과 같이 Pod 읽기 권한만 부여한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: [namespace명]
  name: web-pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
```

CLI로 수동 생성하는 경우에는 다음과 같이 일반화해 적용한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: [Role명]
  namespace: [namespace명]
rules:
  - apiGroups:
      - ""
    resources:
      - pods
    verbs:
      - get
      - list
      - watch
```

적용한다.

```bash
kubectl apply -f pod-reader-role.yaml
```

Role의 주요 필드는 다음과 같다.

| 필드                                | 목적                                    |
| ----------------------------------- | --------------------------------------- |
| `apiGroups: [""]`                   | core API group의 리소스를 대상으로 지정 |
| `resources: ["pods"]`               | Pod 리소스에만 권한 부여                |
| `verbs: ["get", "list", "watch"]`   | 단건 조회, 목록 조회, 변경 감시만 허용  |
| `metadata.namespace: [namespace명]` | 권한 범위를 네임스페이스로 제한         |

이 Role은 Pod를 조회할 수는 있지만 생성, 수정, 삭제할 수 없다. 또한 Secret, ConfigMap, Deployment 같은 다른 리소스에도 접근할 수 없다.

### Step 4: ServiceAccount에 RoleBinding을 설정한다

특정 ServiceAccount가 특정 Role을 사용하도록 RoleBinding을 생성한다.

현재 저장소에서는 같은 `*-rbac.yaml` 파일 안에 RoleBinding도 함께 정의한다. 예를 들어 `web-rbac.yaml`은 `web-pod-reader` Role을 `web-workload` ServiceAccount에 연결한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: web-rb
  namespace: [namespace명]
subjects:
  - kind: ServiceAccount
    name: web-workload
    namespace: [namespace명]
roleRef:
  kind: Role
  name: web-pod-reader
  apiGroup: rbac.authorization.k8s.io
```

작성한 `*-rbac.yaml`은 오버레이의 `kustomization.yaml`에 포함되어야 한다.

```yaml
resources:
  - ../../base
  - default-serviceaccount.yaml
  - api-serviceaccount.yaml
  - web-serviceaccount.yaml
  - db-serviceaccount.yaml
  - web-rbac.yaml
  - api-rbac.yaml
  - db-rbac.yaml
```

운영 반영은 다음처럼 Kustomize 오버레이 단위로 수행한다.

```bash
kubectl apply -k eks-secure-infra/manifests/overlays/[namespace명]
```

CLI로 RoleBinding만 수동 생성하는 경우에는 다음과 같이 작성한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: [RoleBinding명]
  namespace: [namespace명]
subjects:
  - kind: ServiceAccount
    name: [ServiceAccount명]
    namespace: [namespace명]
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: [Role명]
```

적용한다.

```bash
kubectl apply -f [파일명].yaml
```

RoleBinding의 주요 필드는 다음과 같다.

| 필드                            | 목적                                       |
| ------------------------------- | ------------------------------------------ |
| `subjects.kind: ServiceAccount` | 권한을 받을 주체가 ServiceAccount임을 지정 |
| `subjects.name: pod-reader-sa`  | 권한을 받을 ServiceAccount 이름            |
| `roleRef.kind: Role`            | 네임스페이스 Role을 참조                   |
| `roleRef.name: pod-reader`      | 연결할 Role 이름                           |

### Step 5: 사용자에게 RoleBinding을 설정하는 경우

특정 Kubernetes 사용자에게 동일한 권한을 부여하려면 `subjects`를 User로 지정한다. EKS에서는 이 사용자명이 AWS IAM 인증 매핑에서 노출되는 Kubernetes username과 일치해야 한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: user-pod-reader-binding
  namespace: [namespace명]
subjects:
  - kind: User
    name: eks-user
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: [Role명]
```

적용한다.

```bash
kubectl apply -f [파일명].yaml
```

운영 환경에서는 사용자보다 그룹 기반으로 권한을 부여하는 방식이 관리에 유리하다. 예를 들어 특정 그룹에 RoleBinding을 연결하고, IAM Identity Center 또는 IAM Role 매핑에서 사용자를 해당 그룹으로 관리한다.

#### ClusterRole 및 ClusterRoleBinding 적용 기준

Role과 RoleBinding은 네임스페이스 안에서만 권한을 부여한다. 반면 ClusterRole과 ClusterRoleBinding은 클러스터 전체 리소스 또는 모든 네임스페이스에 걸친 권한에 사용한다.

ClusterRole이 필요한 대표 사례는 다음과 같다.

- `nodes`, `namespaces`, `persistentvolumes`처럼 네임스페이스에 속하지 않는 리소스 조회
- 모든 네임스페이스의 Pod를 조회해야 하는 운영 도구
- 클러스터 전체 보안 정책, 감사, 모니터링 도구 권한
- 여러 네임스페이스에 동일한 Role 정의를 재사용해야 하는 경우

단, ClusterRoleBinding은 권한 범위가 넓기 때문에 최소권한 원칙에 따라 신중하게 사용해야 한다. 단일 네임스페이스만 대상으로 한다면 ClusterRoleBinding 대신 RoleBinding을 사용한다.

예를 들어 모든 네임스페이스의 Pod를 조회해야 하는 계정에는 다음과 같이 ClusterRole을 정의할 수 있다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: [ClusterRole명]
rules:
  - apiGroups:
      - ""
    resources:
      - pods
    verbs:
      - get
      - list
      - watch
```

ServiceAccount에 클러스터 전체 Pod 조회 권한을 부여하려면 ClusterRoleBinding을 사용한다.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: [ClusterRoleBinding명]
subjects:
  - kind: ServiceAccount
    name: [ServiceAccount명]
    namespace: [namespace명]
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: [ClusterRole명]
```

이 설정은 특정 네임스페이스의 ServiceAccount가 모든 네임스페이스의 Pod를 조회할 수 있게 만든다. 따라서 실습 목적이 아니라면 특정 네임스페이스 RoleBinding으로 충분한지 먼저 검토해야 한다.

## 검증 방법

먼저 Kustomize 오버레이에 RBAC 리소스가 포함되어 있는지 렌더링 결과를 확인한다.

```bash
kubectl kustomize eks-secure-infra/manifests/overlays/[namespace명]
```

출력 결과에 `kind: Role`, `kind: RoleBinding`, 대상 ServiceAccount 이름이 포함되어 있어야 한다. 실제 클러스터에 적용할 때는 다음 명령을 사용한다.

```bash
kubectl apply -k eks-secure-infra/manifests/overlays/[namespace명]
```

먼저 Role과 RoleBinding이 생성되었는지 확인한다.

```bash
kubectl get role [Role명] -n [namespace명]
kubectl get rolebinding [RoleBinding명] -n [namespace명]
```

Role에 포함된 권한을 확인한다.

```bash
kubectl describe role [Role명] -n [namespace명]
```

기대 결과는 `pods` 리소스에 대해 `get`, `list`, `watch`만 허용되는 것이다.

ServiceAccount 기준으로 허용된 작업을 검증한다.

```bash
kubectl auth can-i get pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]

kubectl auth can-i list pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]

kubectl auth can-i watch pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]
```

기대 결과는 모두 `yes`이다.

허용하지 않은 작업이 차단되는지도 확인한다.

```bash
kubectl auth can-i create pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]

kubectl auth can-i delete pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]

kubectl auth can-i get secrets \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n [namespace명]
```

기대 결과는 모두 `no`이다.

다른 네임스페이스에 접근할 수 없는지도 확인한다.

```bash
kubectl auth can-i list pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  -n default
```

RoleBinding이 특정 네임스페이스에만 적용되어 있다면 기대 결과는 `no`이다.

ClusterRoleBinding을 적용한 경우에는 클러스터 전체 범위 조회가 가능한지 확인한다.

```bash
kubectl auth can-i list pods \
  --as=system:serviceaccount:[namespace명]:[serviceAccount명] \
  --all-namespaces
```

ClusterRoleBinding을 적용했다면 기대 결과는 `yes`이다. 적용하지 않았다면 `no`가 정상이다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 취약한 Pod에서 ServiceAccount 토큰을 탈취한 뒤, 해당 ServiceAccount에 과도한 RBAC 권한이 있으면 Secret 조회, Pod 생성, Deployment 수정 등을 통해 권한 상승이나 횡적 이동을 시도할 수 있다.
- **영향 범위:** 네임스페이스 내 민감 정보 노출, 워크로드 변조, 악성 Pod 배포, 다른 네임스페이스로의 이동, 클러스터 전체 권한 탈취 가능성
- **심각도:** **높음**. RBAC는 Kubernetes API 접근의 핵심 통제 지점이며, 과도한 권한은 침해 사고의 피해 범위를 크게 확대한다.

## 발생 비용

- **AWS 비용 발생 여부 및 예상 규모:** 없음. Kubernetes 기본 RBAC 리소스 생성만으로 적용 가능
- **정책 및 권한 관리 도구:** 대규모 환경에서는 Kyverno, OPA Gatekeeper, RBAC Manager 같은 정책 또는 권한 관리 도구를 추가로 사용할 수 있다.

## 참고 자료

- [Amazon EKS Best Practices - Identity and Access Management](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- [Kubernetes - Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Kubernetes - Configure Service Accounts for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.1 Ensure that the cluster-admin role is only used where required`
  클러스터 관리자 권한은 필요한 경우에만 제한적으로 사용해야 하며, 일반 사용자나 워크로드에는 최소권한 Role을 부여해야 한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.3 Minimize wildcard use in Roles and ClusterRoles`
  Role과 ClusterRole에서 `*` wildcard 사용을 최소화하여 의도하지 않은 권한 확대를 방지해야 한다.
- **CIS Kubernetes Benchmark v1.12.0**
  `5.1.5 Ensure that default service accounts are not actively used`
  워크로드별 전용 ServiceAccount를 생성하고 필요한 권한만 RoleBinding으로 부여해야 한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `RBAC and least privilege`
  사용자와 ServiceAccount에 필요한 최소 권한만 부여하고, 클러스터 전체 권한은 엄격히 제한할 것을 권고한다.


## 적용 시 체크리스트

- [ ] 네임스페이스별로 필요한 권한 범위가 정의되어 있는가?
- [ ] ServiceAccount 또는 사용자에 RoleBinding이 명시적으로 연결되어 있는가?
- [ ] 적용한 권한에 맞게 다른 네임스페이스에 대한 접근이 차단되는가?
- [ ] ClusterRoleBinding이 필요한 경우에만 사용되고 있는가?
- [ ] Role 또는 ClusterRole에 불필요한 `*` wildcard 권한이 없는가?
