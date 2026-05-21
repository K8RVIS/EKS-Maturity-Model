# Workload 내 Hardcoded Secret을 탐지하고 Secrets Manager 참조로 제거한다

> **Phase:** Foundational
>
> **보안 영역:** 데이터 보호
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★★☆

---

## 왜 필요한가

Kubernetes 매니페스트, Kustomize patch, Helm values, Terraform 변수 파일, 애플리케이션 설정 파일, CI/CD 변수에 비밀번호나 토큰을 직접 적어두면 Git 히스토리, Argo CD diff, CI 로그, 이미지 레이어에 값이 오래 남는다. 이후 파일을 수정해도 이미 push된 커밋과 빌드 산출물에서 완전히 사라지지 않으므로, 노출된 값은 로테이션 전까지 유효한 자격증명으로 봐야 한다.

Foundational 단계에서는 단순히 눈으로 `password` 문자열을 찾는 수준을 넘어, 저장소 전체를 스크립트로 반복 탐지하고 탐지된 값을 AWS Secrets Manager 같은 외부 Secret 저장소로 이동해야 한다. 워크로드 매니페스트에는 실제 Secret 값이 아니라 Secret 이름, key, ARN, path 같은 참조만 남긴다.

스크립트 파일을 추가하여 IaC, Kubernetes manifest, 설정 파일의 하드코딩 Secret을 탐지할 수 있게 하며 이 스크립트는 기본적으로 탐지 값을 마스킹해 출력하므로, 탐지 도구 자체가 추가적인 Secret 노출 경로가 되는 위험도 줄인다.

탐지 대상은 다음 유형을 포함한다.

- Private key block
- AWS Access Key와 Secret Access Key
- GitHub, GitLab, Slack, Google, Stripe, SendGrid token
- JWT와 Authorization Bearer token
- URL 내 basic auth credential
- `password`, `secret`, `token`, `api_key`, `access_key`, `private_key`, `client_secret`, `credential` 같은 민감 key에 직접 할당된 값
- Kubernetes env `name`/`value` 조합의 하드코딩 Secret
- Kubernetes Secret 리소스의 `data`, `stringData`
- Terraform 민감 변수의 `default` 값
- 옵션 활성화 시 고엔트로피 문자열

이 항목의 목표는 다음 세 가지다.

- 하드코딩 Secret을 반복 탐지한다.
- 탐지된 실제 값은 새 값으로 로테이션하고 AWS Secrets Manager로 이동한다.
- 워크로드는 External Secrets Operator 또는 Secrets Store CSI Driver를 통해 Secrets Manager의 값을 참조하도록 바꾼다.

## 수행 방법

**사전 조건**

- AWS Secrets Manager 또는 Systems Manager Parameter Store에 Secret을 생성할 권한이 필요하다.
- Pod가 외부 Secret에 접근할 수 있도록 IRSA 또는 EKS Pod Identity를 사용할 수 있어야 한다.
- External Secrets Operator(ESO) 또는 Secrets Store CSI Driver 중 어떤 방식을 사용할지 정해야 한다.
- 이미 Git, CI 로그, 이미지 레이어에 들어간 값은 노출된 것으로 보고 새 값으로 로테이션해야 한다.
- 스캔 결과와 JSON 리포트에는 실제 값이 마스킹되더라도 민감한 파일 경로와 context가 포함될 수 있으므로 보관 위치를 제한한다.

### **Step 1: 스캔 범위와 제외 범위를 정한다**

먼저 저장소 루트에서 기본 스캔을 실행한다.

```bash
python scripts/scan_secrets.py . \
  --format text \
  --fail-on high
```

특정 영역만 우선 확인하려면 IaC, Kubernetes manifest, 설정 파일 경로를 포함한다.

```bash
python scripts/scan_secrets.py . \
  --include "manifests/**" \
  --include "environments/**" \
  --include "modules/**" \
  --include "*.tf" \
  --include "*.tfvars" \
  --include "*.yaml" \
  --include "*.yml" \
  --format text \
  --fail-on high
```

기본적으로 `.git`, `.terraform`, `node_modules`, `dist`, `build`, 바이너리 파일, 큰 파일 등은 제외된다. 추가로 제외할 경로가 있으면 `--exclude`를 반복해서 지정한다.

```bash
python scripts/scan_secrets.py . \
  --exclude "docs/examples/**" \
  --exclude "**/*.lock" \
  --fail-on high
```

### **Step 2: 탐지 결과를 분류한다**

JSON 출력은 CI, PR comment, 보안 리포트에 연결하기 쉽다.

```bash
python scripts/scan_secrets.py . \
  --format json \
  --fail-on none
```

스캐너 결과에는 다음 정보가 포함된다.

- 파일 경로
- line, column
- severity
- rule id와 rule name
- 마스킹된 값
- context
- fingerprint

심각도 기준은 다음처럼 운영한다.

| 심각도 | 처리 기준 |
| --- | --- |
| critical | private key, live 결제 key처럼 즉시 폐기와 로테이션이 필요한 값 |
| high | password, token, Secret data, cloud access key처럼 PR 차단 대상 |
| medium | JWT, high entropy 후보 등 사람이 확인해야 하는 값 |
| low | 정책에 따라 허용 또는 개선 이슈로 전환 가능한 값 |

기본 실행에서는 `--fail-on high`를 사용해 high 이상 결과가 나오면 실패하게 한다. 더 엄격한 점검이 필요하면 entropy 탐지도 켠다.

```bash
python scripts/scan_secrets.py . \
  --enable-entropy \
  --fail-on medium
```

`--enable-entropy`는 무작위 문자열 탐지에 유용하지만 오탐이 늘 수 있다. 처음에는 수동 검토나 야간 점검에 사용하고, allowlist가 정리된 뒤 CI에 포함한다.

### **Step 3: 오탐은 allowlist로 관리한다**

placeholder, template, Terraform reference, Kubernetes Secret reference, ARN/path/name 같은 메타데이터는 스캐너가 기본적으로 최대한 제외하도록 설계되어 있다. 그래도 오탐이 발생하면 inline 무시 주석이나 allowlist 파일로 관리한다.

허용할 fingerprint 또는 경로 패턴을 별도 파일에 둔다.

```text
# .secret-scan-allowlist
docs/examples/.*
.*:k8s-secret-data:example-password.*
```

실행 시 allowlist를 지정한다.

```bash
python scripts/scan_secrets.py . \
  --allowlist .secret-scan-allowlist \
  --fail-on high
```

기본 allowlist까지 끄고 강하게 확인해야 할 때만 `--no-default-allowlist`를 사용한다.

```bash
python scripts/scan_secrets.py . \
  --no-default-allowlist \
  --enable-entropy \
  --fail-on medium
```

`--show-secrets`는 실제 값을 출력하므로 CI, PR, 공유 터미널에서는 사용하지 않는다. 격리된 로컬 환경에서 원인 분석이 꼭 필요할 때만 제한적으로 사용한다.

### **Step 4: 실제 값은 즉시 로테이션한다**

스캐너가 실제 Secret을 찾았다면 파일에서 제거하기 전에 먼저 값을 폐기하거나 새 값으로 교체한다.

1. 탐지된 값이 실제 운영 값인지 확인한다.
2. 연결된 시스템을 식별한다. 예: Redis, PostgreSQL, 외부 API, GitHub token, AWS access key
3. 새 값을 발급한다.
4. 기존 값을 폐기한다.
5. 새 값을 Secrets Manager에 저장한다.
6. 애플리케이션을 새 참조 방식으로 재배포한다.

Git에서 값을 삭제하는 것만으로는 충분하지 않다. 이미 Git 히스토리, CI 로그, 이미지 레이어에 남았을 수 있으므로 로테이션이 먼저다.

### **Step 5: Secret 원본을 AWS Secrets Manager로 이동한다**

민감한 값 자체는 Git에 두지 않고 AWS Secrets Manager에 저장한다. namespace별 워크로드라면 path에 namespace를 포함해 권한과 감사를 나누기 쉽게 한다.

```bash
aws secretsmanager create-secret \
  --region <region> \
  --name /<namespace>/app/redis \
  --secret-string '{"password":"<new-rotated-redis-password>","url":"redis://:<new-rotated-redis-password>@db:6379/0"}'

aws secretsmanager create-secret \
  --region <region> \
  --name /<namespace>/app/external-postgres \
  --secret-string '{"host":"reporting-db.training.local","port":"5432","database":"reporting","username":"training-api","password":"<new-rotated-postgres-password>"}'
```

모든 팀 namespace에 같은 패턴을 적용하려면 namespace 목록을 기준으로 반복한다.

```bash
for ns in team-a team-b team-c team-d; do
  aws secretsmanager create-secret \
    --region <region> \
    --name "/${ns}/app/redis" \
    --secret-string '{"password":"<new-rotated-redis-password>","url":"redis://:<new-rotated-redis-password>@db:6379/0"}'
done
```

Terraform으로 Secrets Manager Secret 자체를 만들 수는 있지만, `secret_string`을 Terraform에 직접 넣으면 state에 민감 값이 저장될 수 있다. 운영에서는 Secret metadata와 IAM policy는 Terraform으로 관리하고, 실제 Secret value는 안전한 CI/CD secret, 수동 break-glass 절차, rotation Lambda, 또는 제한된 AWS CLI 경로로 주입하는 편이 안전하다.

### **Step 6: Pod가 필요한 Secret만 읽도록 권한을 부여한다**

External Secrets Operator를 사용하는 경우 ESO controller 또는 namespace별 ServiceAccount가 필요한 Secret ARN만 읽을 수 있게 한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": [
        "arn:aws:secretsmanager:<region>:<account-id>:secret:/<namespace>/app/*"
      ]
    }
  ]
}
```

모든 namespace에 대해 공통 controller가 읽어야 한다면 resource pattern을 넓힐 수 있지만, 가능한 한 환경과 애플리케이션 path 단위로 제한한다.

```json
"Resource": [
  "arn:aws:secretsmanager:<region>:<account-id>:secret:/team-a/app/*",
  "arn:aws:secretsmanager:<region>:<account-id>:secret:/team-b/app/*",
  "arn:aws:secretsmanager:<region>:<account-id>:secret:/team-c/app/*",
  "arn:aws:secretsmanager:<region>:<account-id>:secret:/team-d/app/*"
]
```

Secrets Manager가 customer managed KMS key를 사용한다면 `kms:Decrypt` 권한도 key policy와 IAM policy에 반영한다.

### **Step 7: ExternalSecret으로 Kubernetes Secret을 동기화한다**

기존 애플리케이션이 환경변수 기반으로 Secret을 읽는다면 External Secrets Operator가 전환 비용이 낮다. Secrets Manager를 원본으로 두고 Kubernetes Secret은 런타임 주입을 위한 동기화 대상으로만 사용한다.

공통 `ClusterSecretStore` 예시는 다음과 같다.

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: <region>
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

namespace별 `ExternalSecret`은 같은 패턴으로 배포한다.

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: app-runtime-secrets
  namespace: <namespace>
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: app-runtime-secrets
    creationPolicy: Owner
  data:
    - secretKey: redis-password
      remoteRef:
        key: /<namespace>/app/redis
        property: password
    - secretKey: redis-url
      remoteRef:
        key: /<namespace>/app/redis
        property: url
    - secretKey: postgres-password
      remoteRef:
        key: /<namespace>/app/external-postgres
        property: password
```

팀 namespace가 늘어나는 환경에서는 Helm, Kustomize generator, Terraform `for_each`, Argo CD ApplicationSet 중 하나로 namespace별 `ExternalSecret`을 반복 생성한다.

### **Step 8: 워크로드 매니페스트에서 실제 값을 제거한다**

탐지된 `env[].value`, `stringData`, Terraform variable default를 제거하고 `secretKeyRef` 또는 CSI mount 참조로 바꾼다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: <namespace>
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: app-runtime-secrets
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
                  name: app-runtime-secrets
                  key: postgres-password
```

`db` StatefulSet도 Redis password를 Secret 참조로 바꾼다.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: <namespace>
spec:
  template:
    spec:
      containers:
        - name: db
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-runtime-secrets
                  key: redis-password
```

가능하면 connection string 전체를 Secret으로 만들기보다 host, port, database, username, password를 분리한다. 기존 애플리케이션이 `REDIS_URL`만 읽을 수 있다면 초기 전환에서는 URL을 Secret으로 동기화하고, 이후 앱 코드를 개선해 password 분리 주입으로 전환한다.

### **Step 9: 스캐너를 CI와 PR gate에 연결한다**

하드코딩 Secret 제거는 한 번의 정리보다 재유입 방지가 더 중요하다. PR마다 스캐너를 실행해 high 이상 결과를 차단한다.

```yaml
name: secret-scan

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.x"
      - name: Scan hardcoded secrets
        run: |
          python scripts/scan_secrets.py . \
            --format text \
            --fail-on high \
            --allowlist .secret-scan-allowlist
```

CI 로그에는 실제 값을 출력하지 않는다. `--show-secrets`는 사용하지 않고, 필요한 경우 JSON 결과를 보안 접근이 제한된 artifact로만 보관한다.

### **Step 10: 기존 노출 흔적을 정리한다**

실제 운영 Secret이 커밋되었거나 이미지에 들어갔다면 다음 작업을 수행한다.

1. Secret 값을 즉시 로테이션한다.
2. GitHub, GitLab, ECR, CI/CD 로그, Argo CD diff 등 노출 위치를 확인한다.
3. 필요한 경우 `git filter-repo`나 저장소 secret purge 기능으로 히스토리를 정리한다.
4. 기존 이미지 태그를 폐기하고 새 이미지로 재빌드한다.
5. CloudTrail, EKS audit log, Falco runtime alert에서 해당 Secret 사용 흔적을 조사한다.

히스토리 정리는 이미 유출된 값을 안전하게 되돌리는 작업이 아니다. 보안적으로는 로테이션과 기존 값 폐기가 우선이다.

## 검증 방법

스캐너를 다시 실행해 high 이상 결과가 사라졌는지 확인한다.

```bash
python scripts/scan_secrets.py . \
  --format text \
  --fail-on high \
  --allowlist .secret-scan-allowlist
```

기대 결과:

- `No hardcoded secrets found` 또는 허용된 low/medium 결과만 남는다.
- `k8s-env-hardcoded-secret`, `k8s-secret-data`, `terraform-sensitive-variable-default` high 결과가 없다.
- 실제 Secret 값이 출력되지 않는다.

더 강한 점검을 별도로 실행한다.

```bash
python scripts/scan_secrets.py . \
  --enable-entropy \
  --format text \
  --fail-on medium \
  --allowlist .secret-scan-allowlist
```

기대 결과:

- 고엔트로피 후보가 있다면 사람이 검토해 실제 Secret인지 판단한다.
- 오탐은 allowlist에 사유를 남기고 관리한다.

Kustomize 또는 Helm 렌더링 결과에서 평문 값이 없는지 확인한다.

```bash
kubectl kustomize manifests/overlays/<namespace> \
  | rg -n 'password|token|api-key|secret|stringData|value:|valueFrom|secretKeyRef'
```

기대 결과:

- 민감 값은 `value:`로 출력되지 않는다.
- `REDIS_URL`, `EXTERNAL_POSTGRES_PASSWORD`, `REDIS_PASSWORD` 같은 값은 `secretKeyRef` 또는 CSI volume 참조를 사용한다.
- Kubernetes Secret manifest의 `stringData`에 실제 값이 없다.

Secrets Manager에 Secret이 있는지 확인한다.

```bash
aws secretsmanager describe-secret \
  --region <region> \
  --secret-id /<namespace>/app/redis
```

기대 결과:

- Secret metadata가 조회된다.
- 실제 값은 `describe-secret` 출력에 포함되지 않는다.

ExternalSecret 동기화 상태를 확인한다.

```bash
kubectl get externalsecret -n <namespace>
kubectl describe externalsecret app-runtime-secrets -n <namespace>
kubectl get secret app-runtime-secrets -n <namespace>
```

기대 결과:

- ExternalSecret 상태가 `Ready=True`다.
- `app-runtime-secrets` Kubernetes Secret이 생성되어 있다.
- ESO controller 로그에 `AccessDenied`, `ResourceNotFoundException`, `DecryptionFailure`가 없다.

Pod spec에 평문 Secret이 없는지 확인한다.

```bash
kubectl get deploy api -n <namespace> -o yaml \
  | rg -n 'REDIS_URL|EXTERNAL_POSTGRES_PASSWORD|value:|valueFrom|secretKeyRef'

kubectl get statefulset db -n <namespace> -o yaml \
  | rg -n 'REDIS_PASSWORD|value:|valueFrom|secretKeyRef'
```

기대 결과:

- Secret 이름과 key는 보이지만 실제 값은 보이지 않는다.
- 민감 환경변수는 `valueFrom.secretKeyRef`로만 선언된다.

애플리케이션 동작을 확인한다.

```bash
kubectl rollout status deploy/api -n <namespace>
kubectl rollout status statefulset/db -n <namespace>
kubectl logs deploy/api -n <namespace> --tail=100
```

기대 결과:

- 배포가 정상 완료된다.
- 애플리케이션이 Redis와 외부 DB 정보를 정상적으로 읽는다.
- 로그에 password, token, connection string의 실제 값이 출력되지 않는다.

Secrets Manager 접근 감사도 확인한다.

```bash
aws cloudtrail lookup-events \
  --region <region> \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --max-results 20
```

기대 결과:

- ESO 또는 의도한 IAM principal의 `GetSecretValue` 이벤트만 보인다.
- 예상하지 못한 사용자나 role의 조회 이벤트가 없다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 읽기 권한만 있는 Git 저장소, Argo CD 화면, CI 로그, 컨테이너 이미지 레이어에서 DB password나 API token을 확보하고 운영 데이터에 접근한다.
- **탐지 실패:** 수동 `rg` 검색만 사용하면 private key, cloud token, Kubernetes `env` 조합, Terraform default, URL 내 credential 같은 패턴을 놓칠 수 있다.
- **회수 어려움:** Git 히스토리와 이미지 레이어에 들어간 값은 파일 수정만으로 제거되지 않는다. 노출된 값은 새 값으로 로테이션해야 한다.
- **Terraform state 리스크:** Terraform에 실제 Secret value를 넣으면 state에 남을 수 있다. state backend 암호화와 접근 통제, value 주입 경로 분리가 필요하다.
- **Kubernetes Secret 한계:** ExternalSecret이 만든 Kubernetes Secret은 API 권한이 있는 사용자가 조회할 수 있으므로 RBAC, etcd envelope encryption, Secret 접근 감사가 함께 필요하다.
- **운영 리스크:** allowlist를 느슨하게 운영하면 실제 Secret이 예외 처리될 수 있고, 반대로 entropy 탐지를 무리하게 CI에 적용하면 오탐으로 개발 흐름이 막힐 수 있다.
- **심각도:** **높음**. 하드코딩 Secret은 데이터 유출과 권한 탈취로 직접 이어지며, 발견 후에도 로테이션과 히스토리 정리 비용이 크다.

## 인적 리소스 및 비용

- **AWS 비용 발생 여부 및 예상 규모:** Secrets Manager는 Secret 수와 API 호출량에 따라 비용이 발생한다. Parameter Store SecureString을 대안으로 사용할 수 있지만 로테이션과 운영 기능 차이를 고려해야 한다.
- **KMS 비용:** customer managed KMS key를 사용하면 key 월 비용과 API 호출 비용이 발생할 수 있다.
- **도구 비용:** External Secrets Operator, Secrets Store CSI Driver는 오픈소스로 사용할 수 있다. GitHub secret scanning, Gitleaks, TruffleHog 같은 도구를 병행할 수 있다.
- **운영 비용:** 스캔 결과 triage, allowlist 리뷰, Secret 로테이션, ESO 권한 관리, CI gate 유지가 필요하다.
- **사고 대응 비용:** 이미 노출된 Secret은 외부 시스템 비밀번호 변경, token 재발급, 애플리케이션 재배포, 로그 조사, 이미지 재빌드가 필요할 수 있다.

## 참고 자료

- [Kubernetes Secrets 공식 문서](https://kubernetes.io/docs/concepts/configuration/secret/)
- [EKS Best Practices Guide - Secrets Management](https://aws.github.io/aws-eks-best-practices/security/docs/data/#secrets-management)
- [AWS Secrets Manager 공식 문서](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [AWS Systems Manager Parameter Store 공식 문서](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)
- [External Secrets Operator - AWS Secrets Manager provider](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [Secrets Store CSI Driver AWS Provider](https://github.com/aws/secrets-store-csi-driver-provider-aws)
- [GitHub secret scanning](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning)
- [Gitleaks](https://github.com/gitleaks/gitleaks)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  Secret 관리, 민감정보 분리, RBAC 접근 통제, 워크로드 설정 검토 원칙과 연결된다.
- **[NIST SP 800-190](https://csrc.nist.gov/publications/detail/sp/800-190/final)**
  컨테이너 이미지, 오케스트레이터, 런타임 환경에서 자격증명과 민감정보 노출을 줄이는 통제와 연결된다.
- **[CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)**
  Secret 리소스 접근 권한 최소화, 서비스 계정 권한 관리, 민감정보 보호와 연결된다.
- **[CIS Amazon EKS Benchmark](https://www.cisecurity.org/cis-benchmarks)**
  EKS 환경의 IAM/RBAC, control plane logging, Secret 보호 운영 기준과 연결된다.
- **[NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)**
  Kubernetes Secret 보호, least privilege, runtime 노출 최소화 권고와 연결된다.
- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  자격증명 보호, 최소 권한, 자동화된 보안 운영, 데이터 보호 원칙과 연결된다.
- **[NIST SP 800-53 Rev.5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)**
  `AC-6`, `IA-5`, `SC-28`, `SI-4`와 연결된다.

## Assessment 체크리스트

- [ ] 스크립트 파일을 저장소 전체 또는 지정된 IaC/manifest 경로에 실행했는가?
- [ ] CI에서 `--fail-on high` 기준으로 하드코딩 Secret 재유입을 차단하는가?
- [ ] `--show-secrets`를 CI나 공유 로그에서 사용하지 않는가?
- [ ] high/critical 탐지 결과에 대해 실제 Secret 여부를 triage했는가?
- [ ] 실제 노출된 값은 새 값으로 로테이션하고 기존 값을 폐기했는가?
- [ ] Redis, PostgreSQL, 외부 API token 같은 Secret 원본이 AWS Secrets Manager 또는 승인된 외부 Secret 저장소로 이동되었는가?
- [ ] Terraform state에 실제 Secret value가 저장되지 않도록 주입 경로를 분리했는가?
- [ ] ESO 또는 CSI Driver가 필요한 Secret ARN만 읽도록 IAM 권한이 제한되어 있는가?
- [ ] 모든 대상 namespace에 `ExternalSecret` 또는 동등한 Secret 주입 구성이 적용되어 있는가?
- [ ] 워크로드 매니페스트의 민감 환경변수가 `value:` 대신 `secretKeyRef`, CSI mount, SDK 조회 중 하나를 사용하는가?
- [ ] Kustomize/Helm 렌더링 결과에 실제 Secret 값이 출력되지 않는가?
- [ ] Secret 스캔 allowlist가 리뷰되고, 실제 Secret을 예외 처리하지 않도록 관리되는가?
- [ ] Secrets Manager 조회 이력이 CloudTrail에서 감사 가능한가?
- [ ] 애플리케이션 로그에 Secret 값이나 connection string이 출력되지 않는가?
