# Workload 내 Hardcoded Secret을 Kubernetes Secret 참조로 제거한다

> **Phase:** Quick Wins
>
> **보안 영역:** 데이터 보호
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

## 왜 필요한가

Kubernetes 매니페스트, Kustomize patch, Helm values, Terraform 변수 파일, 애플리케이션 코드에 비밀번호나 토큰을 직접 적어두면 Git 히스토리, Argo CD diff, CI/CD 로그, 이미지 레이어를 통해 값이 오래 남는다. 이후 파일을 수정해도 이미 push된 커밋과 빌드 산출물에서 완전히 사라지지 않기 때문에, 노출된 값은 로테이션 전까지 유효한 자격증명으로 봐야 한다.

Quick Wins 단계에서는 외부 Secret storage까지 도입하지 않더라도, 워크로드 매니페스트에서 실제 값을 제거하고 Kubernetes Secret을 `valueFrom.secretKeyRef`로 참조하게 바꾸는 것만으로도 즉시 위험을 줄일 수 있다. 이 방식은 애플리케이션 코드 변경이 거의 없고, 기존 환경변수 기반 앱에도 적용하기 쉽다.

이 문서는 각 namespace에 `app-secrets` Kubernetes Secret을 만들고, `api` Deployment와 `db` StatefulSet이 이 Secret을 참조하도록 변경한다.

다만 Kubernetes Secret의 `data` 필드는 API 표현상 base64 문자열로 보인다. 이는 암호화가 아니라 Kubernetes가 임의의 바이너리 데이터를 YAML/JSON에 담기 위한 직렬화 방식이다.

EKS의 envelope encryption은 이와 다른 계층에서 동작한다. EKS 1.28 이상에서는 Kubernetes API data가 etcd에 저장되기 전에 기본 envelope encryption이 적용된다. 하지만 `kubectl get secret -o yaml`로 조회하면 API server가 etcd에서 데이터를 복호화한 뒤 Kubernetes Secret 객체 형식으로 반환하므로 여전히 base64로 보인다. 따라서 base64로 보인다는 사실만으로 저장 계층 암호화가 꺼져 있다고 판단하면 안 된다.

중요한 점은 `kubectl get secret` 권한이 있는 사용자는 base64 값을 디코딩해 원문을 볼 수 있다는 것이다. Envelope encryption은 etcd와 저장소 계층 노출을 줄이는 at-rest 보호이고, Kubernetes API를 통한 읽기 권한을 막지는 않는다. 따라서 RBAC 최소 권한, EKS envelope encryption 확인, Terraform state 보호를 함께 적용해야 한다.

## 수행 방법

**사전 조건**

- 대상 워크로드의 Kubernetes 매니페스트, Kustomize overlay, Terraform 코드에 접근할 수 있어야 한다.
- Kubernetes Secret을 생성할 수 있는 권한이 필요하다.
- EKS 클러스터 버전과 Secret 저장 계층 암호화 상태를 확인해야 한다. EKS 1.28 이상은 기본 envelope encryption이 적용되며, 1.27 이하에서는 KMS 기반 Secret encryption 설정을 별도로 검토한다.
- 기존에 코드나 이미지에 들어간 값은 노출된 것으로 보고 새 값으로 교체한 뒤 적용한다.
- Terraform으로 Secret을 만들 경우 Terraform state에 민감 값이 남을 수 있으므로 remote state 암호화와 접근 통제를 먼저 확인한다.

### **Step 1: 하드코딩된 시크릿 위치를 찾는다**

저장소 전체에서 시크릿 후보 문자열을 찾는다.

```bash
rg -n --hidden \
  -e 'password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key' \
  -e 'redis://:|postgres://|mysql://|mongodb://|Authorization:' \
  --glob '!**/.git/**' \
  --glob '!**/node_modules/**' \
  .
```

Kubernetes 매니페스트에서는 `env[].value`, `stringData`, `data`, Kustomize patch, Terraform 변수 파일을 집중적으로 확인한다.

```bash
rg -n 'value:|stringData:|data:|password|token|api-key|secret' \
  manifests environments modules
```

`eks-secure-infra`에서의 제거 대상은 다음과 같다.

- `api` Deployment의 `REDIS_URL`
- `api` Deployment의 `EXTERNAL_POSTGRES_PASSWORD`
- `db` StatefulSet의 `REDIS_PASSWORD`

host, port, database 이름처럼 자격증명이 아닌 값은 Secret이 아니라 일반 환경변수로 남길 수 있다. 사용자명도 조직 정책에 따라 민감정보로 분류할 수는 있지만, 이 Quick Wins 항목에서는 하드코딩된 Secret 제거 범위에서 제외하고 비밀번호와 비밀번호가 포함된 connection string에 집중한다.

### **Step 2: namespace 단위 Kubernetes Secret을 만든다**

워크로드가 참조할 Secret 이름은 `app-secrets`로 통일하고, Terraform `kubernetes_secret_v1` 리소스를 사용해 Secret을 생성한다.

```hcl
resource "kubernetes_secret_v1" "app_secrets" {
  for_each = toset(var.secret_enabled_teams)

  metadata {
    name      = "app-secrets"
    namespace = each.value
  }

  data = {
    redis-password    = var.redis_password
    redis-url         = "redis://:${var.redis_password}@db:6379/0"
    postgres-password = var.postgres_password
  }

  depends_on = [kubernetes_namespace_v1.teams]
}
```

이 구조는 팀 namespace가 늘어나도 `secret_enabled_teams`에 포함된 namespace에만 Secret을 만들 수 있다. 모든 팀에 무조건 Secret을 생성하지 않기 때문에 실습 범위와 권한 범위를 분리하기 쉽다.

### **Step 3: 민감 변수는 Terraform sensitive 변수로 받는다**

Secret 값은 Terraform 변수로 받고 `sensitive = true`를 지정한다.

```hcl
variable "secret_enabled_teams" {
  description = "Team namespaces where app-secrets Kubernetes Secret will be created."
  type        = list(string)
  default     = ["<namespace>"]
}

variable "redis_password" {
  description = "Redis password injected into app-secrets Secret."
  type        = string
  sensitive   = true
}

variable "postgres_password" {
  description = "External PostgreSQL password injected into app-secrets Secret."
  type        = string
  sensitive   = true
}
```

`sensitive = true`는 Terraform CLI 출력 노출을 줄여주지만 state 저장 자체를 막지는 않는다. 따라서 state backend는 S3 SSE-KMS, bucket policy, 접근 로그, DynamoDB lock 등으로 보호한다.

적용 시에는 실제 값을 Git에 남기지 않는 입력 경로를 사용한다.

```bash
export TF_VAR_redis_password='<new-rotated-redis-password>'
export TF_VAR_postgres_password='<new-rotated-postgres-password>'

terraform apply
```

로컬 `terraform.tfvars`를 사용할 수밖에 없다면 `.gitignore`에 포함하고, 이미 커밋된 적이 있는 값은 즉시 로테이션한다.

### **Step 4: platform module에 Secret 변수를 연결한다**

namespace module이 Secret을 만들 수 있도록 platform 환경에서 변수를 넘긴다.

```hcl
module "namespaces" {
  source = "../../modules/namespaces"

  project_name         = var.project_name
  team_names           = var.team_names
  secret_enabled_teams = var.secret_enabled_teams
  redis_password       = var.redis_password
  postgres_password    = var.postgres_password

  depends_on = [module.k8s_base]
}
```

이 단계의 목적은 Kubernetes Secret 생성 책임을 namespace 구성과 같은 IaC 흐름에 포함시키는 것이다. 사람이 `kubectl create secret`을 수동 실행하는 방식보다 변경 이력과 재현성이 좋다.

### **Step 5: api Deployment의 하드코딩 Secret을 제거한다**

`api` 워크로드는 `app-secrets`의 key를 `secretKeyRef`로 참조한다. `manifests/overlays/<namespace>/api-patch.yaml`에 patch를 추가한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - $patch: replace
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: redis-url
            - name: EXTERNAL_POSTGRES_HOST
              value: reporting-db.training.local
            - name: EXTERNAL_POSTGRES_PORT
              value: "5432"
            - name: EXTERNAL_POSTGRES_DATABASE
              value: reporting
            - name: EXTERNAL_POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: postgres-password
```

여기서 `EXTERNAL_POSTGRES_HOST`, `EXTERNAL_POSTGRES_PORT`, `EXTERNAL_POSTGRES_DATABASE`는 민감정보가 아니므로 일반 `value`로 유지한다. 반면 비밀번호와 비밀번호가 포함된 Redis URL은 Secret 참조로 전환한다.

`- $patch: replace`를 사용하는 이유는 기존 `env` 배열에 있던 평문 값이 병합 과정에서 남는 일을 막기 위해서다. Kustomize 배열 patch는 예상과 다르게 병합될 수 있으므로, Secret 제거 작업에서는 기존 환경변수 목록을 명시적으로 교체하는 편이 안전하다.

### **Step 6: db StatefulSet의 하드코딩 Secret을 제거한다**

`db` 워크로드도 같은 `app-secrets`를 참조한다. `manifests/overlays/<namespace>/db-patch.yaml`에 patch를 추가한다.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  template:
    spec:
      containers:
        - name: db
          env:
            - $patch: replace
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: redis-password
```

Redis 서버 실행 명령이 `$REDIS_PASSWORD` 환경변수를 사용한다면, 애플리케이션 명령은 그대로 두고 환경변수 주입 방식만 Secret 참조로 바꾸면 된다.

### **Step 7: Kustomize overlay에 patch를 연결한다**

`team-b` overlay에서 `api`와 `db` patch를 적용한다.

```yaml
patches:
  - path: db-patch.yaml
    target:
      kind: StatefulSet
      name: db
  - path: api-patch.yaml
    target:
      kind: Deployment
      name: api
```

이렇게 하면 base manifest를 직접 수정하지 않고도 특정 팀 namespace에만 Secret 참조 정책을 적용할 수 있다. 실습 팀별로 적용 범위를 다르게 가져가야 할 때 overlay 기준 변경이 더 명확하다.

### **Step 8: Secret 접근 권한과 재유입을 통제한다**

Kubernetes Secret 참조로 바꿨더라도 Secret을 읽을 수 있는 권한이 넓으면 위험은 계속 남는다.

- `get/list/watch secrets` 권한은 운영자와 필요한 controller에만 부여한다.
- 애플리케이션 ServiceAccount에 Secret 조회 권한을 직접 부여하지 않아도 `secretKeyRef` 주입은 kubelet이 처리한다.
- `kubectl get secret -o yaml`에서 `data`가 base64로 보이는 것은 정상이다. 이는 API 응답 형식이며, etcd 저장 전 envelope encryption 적용 여부와는 별개의 문제다.
- EKS 1.28 이상에서는 Kubernetes API data에 기본 envelope encryption이 적용된다. EKS 1.27 이하에서는 KMS 기반 Secret encryption을 별도로 활성화해야 한다.
- Terraform state backend는 암호화하고 접근 권한을 제한한다.
- PR과 CI에서 secret scanning을 실행해 하드코딩 Secret 재유입을 막는다.

간단한 재유입 점검 예시는 다음과 같다.

```bash
rg -n --hidden \
  -e 'training-password|training-external-password' \
  -e 'redis://:[^@]+@' \
  -e 'EXTERNAL_POSTGRES_PASSWORD.*value:' \
  --glob '!**/.git/**' \
  .
```

문서나 테스트에 더미 값을 써야 한다면 `example`, `dummy`, `mock`처럼 실제 값이 아님을 명확히 표시한다.

## 검증 방법

저장소에 기존 평문 값이 남아 있지 않은지 확인한다.

```bash
rg -n --hidden \
  -e 'training-password|training-external-password' \
  -e 'redis://:[^@]+@' \
  -e 'EXTERNAL_POSTGRES_PASSWORD.*value:' \
  --glob '!**/.git/**' \
  .
```

기대 결과:

- 실제 password 값이 검색되지 않는다.
- 민감 환경변수는 `value:`가 아니라 `valueFrom.secretKeyRef`로 선언된다.
- `terraform.tfvars` 같은 민감 변수 파일이 Git 추적 대상에 포함되지 않는다.

Kustomize 렌더링 결과를 확인한다.

```bash
kubectl kustomize manifests/overlays/<namespace> \
  | rg -n 'REDIS_URL|REDIS_PASSWORD|EXTERNAL_POSTGRES|value:|valueFrom|secretKeyRef'
```

기대 결과:

- `REDIS_URL`, `EXTERNAL_POSTGRES_PASSWORD`, `REDIS_PASSWORD`가 `secretKeyRef`를 사용한다.
- host, port, database처럼 민감하지 않은 값만 일반 `value`로 남는다.
- 기존 password나 password가 포함된 connection string이 출력되지 않는다.

Secret 생성 여부를 확인한다.

```bash
kubectl get secret app-secrets -n <namespace>
kubectl describe secret app-secrets -n <namespace>
```

기대 결과:

- `app-secrets`가 존재한다.
- `redis-password`, `redis-url`, `postgres-password` key가 존재한다.
- `describe secret` 출력에는 실제 값이 표시되지 않는다.

Secret을 YAML로 조회하면 `data` 값은 base64로 표시된다.

```bash
kubectl get secret app-secrets -n <namespace> -o yaml
```

기대 결과:

- `data.redis-password`, `data.redis-url`, `data.postgres-password` 값이 base64 문자열로 보인다.
- 이것은 Kubernetes Secret API의 정상 표현 방식으로 base64로 보인다는 사실은 EKS envelope encryption이 미적용되었다는 의미가 아니다.

EKS 저장 계층 envelope encryption 상태는 클러스터 버전과 encryption 설정으로 확인가능하다.

```bash
aws eks describe-cluster \
  --name <cluster-name> \
  --region <region> \
  --query 'cluster.{Version:version,EncryptionConfig:encryptionConfig}' \
  --output yaml
```

기대 결과:

- EKS 1.28 이상이면 Kubernetes API data에 기본 envelope encryption이 적용된다.
- AWS owned key로 기본 envelope encryption을 사용하는 경우 KMS key ARN이 출력되지 않을 수 있다.
- customer managed KMS key를 사용하는 경우 `encryptionConfig`에서 key ARN을 확인할 수 있다.
- EKS 1.27 이하라면 `encryptionConfig`에 Secret encryption 설정이 있는지 별도로 확인한다.

Pod spec에 평문 값이 없는지 확인한다.

```bash
kubectl get deploy api -n <namespace> -o yaml \
  | rg -n 'REDIS_URL|EXTERNAL_POSTGRES|value:|valueFrom|secretKeyRef'

kubectl get statefulset db -n <namespace> -o yaml \
  | rg -n 'REDIS_PASSWORD|value:|valueFrom|secretKeyRef'
```

기대 결과:

- 민감 값은 `secretKeyRef`로만 보인다.
- Secret 이름과 key는 보이지만 실제 값은 보이지 않는다.

애플리케이션 동작도 확인한다.

```bash
kubectl rollout status deploy/api -n <namespace>
kubectl rollout status statefulset/db -n <namespace>
kubectl get pods -n <namespace>
kubectl logs deploy/api -n <namespace> --tail=100
```

기대 결과:

- 배포가 정상 완료된다.
- API와 DB Pod가 정상 기동한다.
- 로그에 password, token, connection string의 실제 값이 출력되지 않는다.

주의할 점은, 환경변수 방식은 Pod 내부 런타임에는 값이 존재한다는 것이다.

```bash
kubectl exec -n <namespace> deploy/api -- env | rg -i 'password|redis|postgres'
```

이 명령에서 값이 보일 수 있다. Quick Wins의 목표는 "Git과 매니페스트에 평문 값을 남기지 않는 것"이며, 런타임 환경변수 노출까지 줄이려면 파일 마운트, SDK 조회, 외부 Secret storage 연계를 추가로 검토한다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 읽기 권한만 있는 Git 저장소, Argo CD UI, CI 로그, 이미지 레이어에서 DB password나 Redis password를 확보하고 애플리케이션 데이터에 접근한다.
- **영향 범위:** Redis, 외부 PostgreSQL, 내부 API, 외부 SaaS 토큰 등 Secret이 연결된 시스템으로 피해가 확장될 수 있다.
- **회수 어려움:** Git 히스토리와 컨테이너 이미지 레이어에 들어간 값은 파일 수정만으로 제거되지 않는다. 노출된 값은 새 값으로 로테이션해야 한다.
- **Kubernetes Secret 한계:** Secret은 API 응답에서 base64로 표현되며, Secret 읽기 권한이 있는 사용자는 값을 디코딩할 수 있다. EKS envelope encryption은 etcd 저장 계층 보호이지 Kubernetes API 읽기 권한을 대체하지 않는다.
- **Terraform state 리스크:** Terraform으로 Kubernetes Secret을 만들면 민감 값이 state에 저장될 수 있으므로 backend 보호가 필수다.
- **운영 리스크:** 여러 overlay와 values 파일에 값을 복사하면 환경별 값 불일치, 잘못된 운영 password 배포, 로테이션 누락이 발생하기 쉽다.
- **심각도:** **높음**. 하드코딩된 시크릿은 데이터 유출과 권한 탈취로 직접 이어질 수 있다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부 및 예상 규모:** Kubernetes Secret 자체에는 추가 AWS 비용이 없다. EKS 1.28 이상의 기본 envelope encryption에서 AWS owned key를 사용하는 경우 추가 비용은 없다. customer managed KMS key를 사용하면 KMS key와 API 호출 비용이 발생할 수 있다.
- **도구 비용:** Kubernetes 기본 기능과 Terraform provider로 적용할 수 있다. Gitleaks, TruffleHog 같은 오픈소스 secret scanning 도구는 별도 라이선스 비용 없이 사용할 수 있다.
- **운영 고려사항:** Terraform state 보호, RBAC 관리, Secret 로테이션 절차, 로그 마스킹, GitOps 도구의 Secret 접근 권한을 함께 운영해야 한다.

## 참고 자료

- [K8RVIS/eks-secure-infra PR #44](https://github.com/K8RVIS/eks-secure-infra/pull/44)
- [Kubernetes Secrets 공식 문서](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes - Distribute credentials securely using Secrets](https://kubernetes.io/docs/tasks/inject-data-application/distribute-credentials-secure/)
- [EKS Best Practices Guide - Secrets Management](https://aws.github.io/aws-eks-best-practices/security/docs/data/#secrets-management)
- [Amazon EKS - Default envelope encryption for all Kubernetes API Data](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-encryption.html)
- [AWS EKS - Enable secret encryption on an existing cluster](https://docs.aws.amazon.com/eks/latest/userguide/enable-kms.html)
- [Terraform Kubernetes Provider - kubernetes_secret_v1](https://registry.terraform.io/providers/hashicorp/kubernetes/latest/docs/resources/secret_v1)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **Kubernetes Security Checklist**
  Secret 관리, 민감정보 분리, RBAC 접근 통제, 워크로드 설정 검토 원칙과 연결된다.
- **CIS Kubernetes Benchmark**
  Secret 리소스 접근 권한 최소화, 불필요한 Secret 열람 권한 제거, namespace 단위 권한 분리와 연결된다.
- **CIS Amazon EKS Benchmark**
  EKS에서 Secret 암호화와 IAM/RBAC 접근 통제를 함께 적용해야 한다는 데이터 보호 원칙과 연결된다.
- **NSA/CISA Kubernetes Hardening Guidance**
  민감정보를 Pod spec과 이미지에 직접 포함하지 않고 Kubernetes Secret과 접근 통제로 분리하는 권고와 연결된다.
- **AWS Well-Architected Framework - Security Pillar**
  자격증명 보호, 최소 권한, 민감 데이터 보호, 감사 가능한 변경 관리 원칙과 연결된다.

## Assessment 체크리스트

- [ ] `api` Deployment의 `REDIS_URL`이 `app-secrets`의 `redis-url` key를 참조하는가?
- [ ] `api` Deployment의 `EXTERNAL_POSTGRES_PASSWORD`가 `app-secrets`의 `postgres-password` key를 참조하는가?
- [ ] `db` StatefulSet의 `REDIS_PASSWORD`가 `app-secrets`의 `redis-password` key를 참조하는가?
- [ ] Kustomize patch에서 기존 `env` 배열을 명시적으로 교체해 평문 값이 남지 않도록 했는가?
- [ ] 실제 Secret 값이 Git에 커밋되는 YAML, `terraform.tfvars`, CI 로그에 남지 않는가?
- [ ] Terraform state backend가 암호화되고 접근 권한이 제한되어 있는가?
- [ ] EKS 1.28 이상 기본 envelope encryption 적용 대상인지, 또는 1.27 이하에서 KMS Secret encryption이 설정되어 있는지 확인했는가?
- [ ] 기존에 노출된 password와 token을 새 값으로 로테이션했는가?
- [ ] Kustomize 렌더링 결과에서 민감 값이 평문으로 출력되지 않는가?
- [ ] 배포 후 Pod가 정상 기동하고 애플리케이션 로그에 Secret 값이 출력되지 않는가?
