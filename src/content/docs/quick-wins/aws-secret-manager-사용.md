---
title: "Pod 연계 external Secret storage를 사용한다"
description: "애플리케이션 코드, 컨테이너 이미지, Helm values, Kubernetes 매니페스트, CI/CD 변수에 비밀번호, 토큰, API Key 같은 시크릿 값이 직접 들어가 있으면 한 번의 커밋이나 이미지 빌드만으로 장기간 노출이 지속된다. Git 히스토리, 이미지 레"
phase: "Quick Wins"
domain: "데이터 보호"
difficulty: "★★☆"
owner: "공통 (전체 실습)"
order: 30
sidebar:
  order: 30
---

## 왜 필요한가

애플리케이션 코드, 컨테이너 이미지, Helm values, Kubernetes 매니페스트, CI/CD 변수에 비밀번호, 토큰, API Key 같은 시크릿 값이 직접 들어가 있으면 한 번의 커밋이나 이미지 빌드만으로 장기간 노출이 지속된다. Git 히스토리, 이미지 레이어, 빌드 로그, Argo CD diff, 배포 산출물에 남은 값은 나중에 파일을 수정해도 완전히 사라지지 않는다.

EKS에서는 같은 컨테이너 이미지와 매니페스트 패턴을 dev, stage, prod에 반복 적용하는 경우가 많다. 이때 하나의 하드코딩된 시크릿이 여러 환경에서 재사용되면 낮은 권한의 개발 환경 노출이 운영 환경 침해로 이어질 수 있다. 따라서 워크로드에는 실제 값이 아니라 외부 시크릿의 참조 이름만 남기고, 런타임 주입은 Kubernetes와 AWS의 통합 방식으로 처리해야 한다.

Kubernetes 문서와 EKS 보안 가이드는 민감정보를 일반 설정값처럼 취급하지 말고 별도 보호 체계로 분리할 것을 권장한다. 현재 [`eks-vulnerable-infra`](https://github.com/K8RVIS/eks-vulnerable-infra) 실습 매니페스트에도 취약한 예시가 존재한다.<br>
[`eks-vulnerable-infra/manifests/base/api/deployment.yaml`](https://github.com/K8RVIS/eks-vulnerable-infra/blob/main/manifests/base/api/deployment.yaml)에서의 `REDIS_URL`과 `EXTERNAL_POSTGRES_PASSWORD`를 평문 `value`로 선언하고, [`eks-vulnerable-infra/manifests/base/db/statefulset.yaml`](https://github.com/K8RVIS/eks-vulnerable-infra/blob/main/manifests/base/db/statefulset.yaml)에서는 `REDIS_PASSWORD`를 평문으로 선언한다. <br>
따라서 이런 민감정보를 제거하고 외부 참조 기반으로 전환하고자 한다.

## 수행 방법

**사전 조건**

- 워크로드 저장소, Helm chart, Kustomize overlay, Terraform 변수, CI/CD 변수에 접근할 수 있어야 한다.
- AWS Secrets Manager 또는 Systems Manager Parameter Store에 시크릿을 생성할 권한이 필요하다.
- Pod가 외부 시크릿에 접근할 수 있도록 IRSA 또는 EKS Pod Identity를 사용할 수 있어야 한다.
- External Secrets Operator(ESO) 또는 Secrets Store CSI Driver 중 어떤 방식을 사용할지 정해야 한다.
- ESO 방식을 사용하는 경우 클러스터에 External Secrets Operator가 설치되어 있고,
  `SecretStore`와 `ExternalSecret` CRD를 사용할 수 있어야 한다.
- 이미 Git이나 이미지 레이어에 들어간 기존 하드코딩 시크릿 값은 노출된 것으로 간주하고 삭제 전에 새 값으로 변경하여 적용할 필요가 있다.
- 현 단계에서는 암호 자동 로테이션 적용을 고려하지 않고 진행한다.

### Step 1: 하드코딩된 시크릿 위치를 식별한다

소스코드와 배포 파일 전체에서 시크릿 후보를 검색한다.

```bash
rg -n --hidden \
  -e 'password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key' \
  -e 'redis://:|postgres://|mysql://|mongodb://|Authorization:' \
  --glob '!**/.git/**' \
  --glob '!**/node_modules/**' \
  .
```

매니페스트에서는 `env[].value`, Helm values, ConfigMap, Secret 리소스의 `stringData`와 `data`를 집중적으로 확인한다.

```bash
rg -n 'value:|stringData:|data:|password|token|api-key|secret' \
  eks-vulnerable-infra/manifests eks-vulnerable-infra/environments
```

이미지 빌드 컨텍스트도 함께 확인한다. `.dockerignore`가 없거나 느슨하면 `.env`, 테스트 인증서, 로컬 설정 파일이 이미지 레이어에 들어갈 수 있다.

```bash
rg -n --hidden 'password|secret|token|api[_-]?key' \
  --glob 'Dockerfile' \
  --glob '.dockerignore' \
  --glob '.env*' \
  .
```

### Step 2: 시크릿 원본을 AWS 관리형 저장소로 이동한다

민감한 값 자체는 Git에 두지 않고 Secrets Manager 또는 Parameter Store에 저장한다.

| 항목 | Secrets Manager | Parameter Store SecureString |
| --- | --- | --- |
| 주요 용도 | DB 자격증명, API token, 로테이션 대상 시크릿 | 비교적 단순한 설정형 시크릿 |
| 암호화 | KMS 암호화 | KMS 암호화 |
| 자동 로테이션 | 지원 | 직접 구현 필요 |
| 비용 | 시크릿 및 API 호출 비용 발생 | Standard tier는 저비용, 사용량에 따라 비용 발생 |
| 선택 기준 | 운영 DB 비밀번호와 외부 API Key에 우선 권장 | 단순하고 로테이션 빈도가 낮은 값에 적합 |

예시는 Secrets Manager 기준이다.

```bash
aws secretsmanager create-secret \
  --name /<namespace>/app/redis \
  --secret-string '{"password":"<new-rotated-redis-password>"}'

aws secretsmanager create-secret \
  --name /<namespace>/app/external-postgres \
  --secret-string '{"host":"reporting-db.training.local","port":"5432","database":"reporting","username":"training-api","password":"<new-rotated-postgres-password>"}'
```

이미 노출된 `training-password`, `training-external-password` 같은 값은 저장소로 옮기는 것만으로 충분하지 않다. 따라서 새 값으로 로테이션하고, 기존 값은 폐기해야 한다.

### Step 3: Pod 주입 방식을 선택한다

EKS 워크로드에서는 다음 두 방식을 주로 사용한다.

| 방식 | 장점 | 주의점 | 권장 사용처 |
| --- | --- | --- | --- |
| External Secrets Operator | Kubernetes Secret으로 동기화되어 기존 `secretKeyRef` 패턴을 그대로 사용 가능 | Kubernetes Secret 보호, RBAC, etcd 암호화가 중요 | 기존 앱이 환경변수 기반 시크릿을 기대하는 경우 |
| Secrets Store CSI Driver | 시크릿을 파일로 마운트하고 Kubernetes Secret 생성을 줄일 수 있음 | 앱이 파일 기반 로딩을 지원해야 하며 rotation 동작을 검증해야 함 | Secret 값을 Kubernetes API에 오래 남기고 싶지 않은 경우 |

기존 매니페스트가 환경변수 기반이면 ESO를 먼저 적용하는 편이 전환 비용이 낮다. 장기적으로는 앱이 파일 기반 또는 SDK 기반 Secret 로딩을 지원하도록 개선하면 환경변수 노출 위험도 줄일 수 있다.

ESO 방식을 선택했다면 `SecretStore`, `ExternalSecret` 리소스를 적용하기 전에 클러스터에 External Secrets Operator와 CRD가 설치되어 있어야 한다.

먼저 CRD와 controller Pod 상태를 확인한다.

```bash
kubectl get crd | rg 'external-secrets.io'
kubectl get pods -n external-secrets
```

기대 결과:

`externalsecrets.external-secrets.io`, `secretstores.external-secrets.io`, `clustersecretstores.external-secrets.io` 같은 CRD가 존재하며, `external-secrets` namespace의 controller Pod가 Running 상태이다.

설치되어 있지 않다면 Helm으로 설치한다.

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  -n external-secrets \
  --create-namespace
```
설치 후 controller와 CRD가 준비될 때까지 확인한다.
```bash
kubectl rollout status deployment/external-secrets -n external-secrets

kubectl get crd externalsecrets.external-secrets.io
kubectl get crd secretstores.external-secrets.io
kubectl get crd clustersecretstores.external-secrets.io
```
기대 결과:

ESO controller 배포가 정상 완료되고, ExternalSecret, SecretStore, ClusterSecretStore CRD를 사용할 수 있다.

### Step 4: IRSA 또는 Pod Identity로 최소 권한을 부여한다

ESO를 사용하는 경우 ESO controller의 ServiceAccount에 필요한 Secret ARN만 읽을 수 있는 권한을 연결한다. 권한은 wildcard를 넓게 열지 않고 네임스페이스나 애플리케이션 경로 단위로 제한한다.

예시는 IRSA 기준이다.
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

Secrets Manager가 customer managed KMS key를 사용한다면 해당 key에 대한 `kms:Decrypt` 권한도 필요하다.

### Step 5: ExternalSecret으로 Kubernetes Secret을 생성한다

ESO를 기준으로 SecretStore와 ExternalSecret을 선언한다.

```yaml
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: <namespace>-secrets-manager
  namespace: <namespace>
spec:
  provider:
    aws:
      service: SecretsManager
      region: <region>
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: app-runtime-secrets
  namespace: <namespace>
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: <namespace>-secrets-manager
    kind: SecretStore
  target:
    name: app-runtime-secrets
    creationPolicy: Owner
  data:
    - secretKey: REDIS_PASSWORD
      remoteRef:
        key: /<namespace>/app/redis
        property: password
    - secretKey: EXTERNAL_POSTGRES_PASSWORD
      remoteRef:
        key: /<namespace>/app/external-postgres
        property: password
```

### Step 6: 워크로드에는 값 대신 참조만 남긴다

평문 `value`를 제거하고 `secretKeyRef` 또는 파일 마운트로 변경한다.

```yaml
env:
  - name: REDIS_PASSWORD
    valueFrom:
      secretKeyRef:
        name: app-runtime-secrets
        key: REDIS_PASSWORD
  - name: REDIS_URL
    value: redis://:$(REDIS_PASSWORD)@db:6379/0
  - name: EXTERNAL_POSTGRES_PASSWORD
    valueFrom:
      secretKeyRef:
        name: app-runtime-secrets
        key: EXTERNAL_POSTGRES_PASSWORD
```

가능하면 연결 문자열 전체를 평문으로 만들지 말고, 애플리케이션이 host, port, username, password를 분리된 환경변수나 파일에서 읽도록 수정한다. 환경변수는 Pod spec과 프로세스 환경에 노출될 수 있으므로, 고위험 시크릿은 파일 마운트 방식이나 애플리케이션 SDK 기반 조회를 우선 검토한다.

### Step 7: Git 히스토리와 이미지 레이어 오염을 처리한다

이미 실제 운영 시크릿이 커밋되었거나 이미지에 들어갔다면 다음을 수행한다.

1. 해당 시크릿을 즉시 로테이션한다.
2. GitHub, GitLab, ECR, CI/CD 로그 등 노출 위치를 식별한다.
3. 필요한 경우 `git filter-repo` 또는 저장소의 secret purge 기능으로 히스토리를 정리한다.
4. 기존 이미지 태그를 폐기하고 새 이미지로 재빌드한다.
5. 하드코딩 방지를 위해 secret scanning을 PR과 CI에 추가한다.

히스토리 정리는 이미 유출된 값을 "안전하게 되돌리는" 작업이 아니라, 향후 재노출과 우발적 확산을 줄이는 작업이다. 보안적으로는 로테이션이 우선이다.

## 검증 방법

저장소에 시크릿 후보 문자열이 남아 있지 않은지 확인한다.

```bash
rg -n --hidden \
  -e 'training-password|training-external-password' \
  -e 'password[[:space:]]*[:=]' \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'redis://:[^@]+@' \
  --glob '!**/.git/**' \
  .
```

기대 결과는 실제 시크릿 값이 검색되지 않는 것이다. 문서나 테스트에 의도된 더미 값이 있다면 `example`, `dummy`, `mock`처럼 명확히 표시하고 운영 값과 절대 같지 않아야 한다.

Kubernetes 매니페스트와 Helm 렌더링 결과에 평문 `value`가 남아 있는지 확인한다.

```bash
kubectl kustomize eks-vulnerable-infra/manifests/overlays/<namespace> \
  | rg -n 'password|token|api-key|secret|value:'

helm template <release> <chart> -f values.yaml \
  | rg -n 'password|token|api-key|secret|stringData|value:'
```

기대 결과:

- 비밀번호, 토큰, API Key의 실제 값이 출력되지 않는다.
- 민감 환경변수는 `valueFrom.secretKeyRef` 또는 CSI volume 참조로 선언된다.
- Secret 리소스가 Git에 평문 `stringData`로 저장되지 않는다.

클러스터에서 ESO 동기화 상태를 확인한다.

```bash
kubectl get externalsecret -n <namespace>
kubectl describe externalsecret app-runtime-secrets -n <namespace>
kubectl get secret app-runtime-secrets -n <namespace>
```

기대 결과:

- ExternalSecret의 상태가 `Ready=True`다.
- target Kubernetes Secret이 생성되어 있다.
- ESO controller 로그에 `AccessDenied`, `ResourceNotFoundException`, `DecryptionFailure`가 없다.

실제 Pod spec에 평문 값이 없는지 확인한다.

```bash
kubectl get deploy api -n <namespace> -o yaml \
  | rg -n 'REDIS_URL|EXTERNAL_POSTGRES_PASSWORD|value:|valueFrom|secretKeyRef'

kubectl get statefulset db -n <namespace> -o yaml \
  | rg -n 'REDIS_PASSWORD|value:|valueFrom|secretKeyRef'
```

기대 결과:

- 민감 값이 `value:`로 보이지 않고 `secretKeyRef`나 CSI volume 참조로만 보인다.

마지막으로 애플리케이션 동작을 확인한다.

```bash
kubectl rollout status deploy/api -n <namespace>
kubectl rollout status statefulset/db -n <namespace>
kubectl logs deploy/api -n <namespace> --tail=100
```

기대 결과:

- 배포가 정상 완료된다.
- 애플리케이션이 Redis와 외부 DB 참조를 정상적으로 읽는다.
- 로그에 시크릿 값이 출력되지 않는다.

## Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 읽기 권한만 있는 Git 저장소, Argo CD 화면, CI 로그, 컨테이너 이미지 레이어에서 DB 비밀번호나 외부 API token을 확보하고 운영 데이터에 직접 접근한다.
- **영향 범위:** 애플리케이션 DB, 캐시, 외부 SaaS, Cloudflare 같은 운영 도구 권한까지 확장될 수 있다. 같은 시크릿이 여러 환경에서 재사용되면 dev 노출이 prod 침해로 이어질 수 있다.
- **회수 어려움:** Git 히스토리와 이미지 레이어에 남은 시크릿은 파일 수정만으로 제거되지 않으므로 노출된 값은 로테이션 전까지 유효하다고 봐야 한다.
- **감사 및 컴플라이언스 리스크:** 민감정보와 자격증명이 코드 저장소에 섞이면 접근 통제, 변경 이력, 보존 정책의 경계가 무너진다.
- **운영 장애:** 시크릿을 수동으로 여러 values 파일에 복사하면 환경별 값 불일치, 잘못된 운영 비밀번호 배포, 로테이션 누락이 발생하기 쉽다.
- **심각도:** **높음**. 하드코딩된 시크릿은 데이터 유출과 권한 탈취로 직접 이어질 수 있으며, 사후 정리 비용이 크다.

## 발생 비용

- **AWS 비용 발생 여부 및 예상 규모:** Secrets Manager는 시크릿 수와 API 호출량에 따라 비용이 발생한다. Parameter Store SecureString은 사용 tier와 KMS 호출량에 따라 비용이 발생할 수 있다. KMS customer managed key를 사용하면 key 보관 및 API 호출 비용도 고려한다.
- **오픈소스 도구 비용:** External Secrets Operator와 Secrets Store CSI Driver 자체는 오픈소스이며 별도 라이선스 비용은 없다. 다만 controller 운영, 업그레이드, 모니터링에 플랫폼 운영 시간이 필요하다.
- **로테이션 비용:** 이미 노출된 시크릿은 외부 시스템 비밀번호 변경, 애플리케이션 재배포, 연결 테스트가 필요하므로 단순 매니페스트 수정보다 작업 시간이 늘어날 수 있다.
- **대안 비용:** 상용 secret scanning 도구를 도입하면 탐지와 정책 관리가 쉬워지지만 좌석 또는 저장소 단위 비용이 발생할 수 있다. GitHub secret scanning, GitLab secret detection, Gitleaks 같은 도구를 조합할 수 있다.

## 참고 자료

- [Kubernetes Secrets 공식 문서](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)
- [EKS Best Practices Guide - Secrets Management](https://aws.github.io/aws-eks-best-practices/security/docs/data/#secrets-management)
- [AWS Secrets Manager 공식 문서](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [AWS Systems Manager Parameter Store 공식 문서](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)
- [External Secrets Operator - AWS Secrets Manager provider](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [Secrets Store CSI Driver AWS Provider](https://github.com/aws/secrets-store-csi-driver-provider-aws)
- [NIST SP 800-190 Application Container Security Guide](https://csrc.nist.gov/publications/detail/sp/800-190/final)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 연결된다.

- **[Kubernetes Security Checklist](https://kubernetes.io/docs/concepts/security/security-checklist/)**
  Secret 관리, 민감정보 분리, 접근 통제, 기본 보안 점검 원칙과 연결된다.
- **[NIST SP 800-190](https://csrc.nist.gov/publications/detail/sp/800-190/final)**
  컨테이너 이미지, 오케스트레이터, 런타임 환경에서 자격증명과 민감정보 노출을 줄이는 통제와 연결된다.
- **[AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)**
  자격 증명 보호, 최소 권한, 자동화된 보안 운영, 데이터 보호 원칙과 연결된다.
- **[CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes)**
  Secret 접근 권한 최소화, etcd 암호화, 서비스 계정 권한 관리와 연결된다.

## 적용 시 체크리스트

- [ ] 애플리케이션 코드와 테스트 코드에 실제 비밀번호, token, API Key가 남아 있지 않는가?
- [ ] Kubernetes 매니페스트, Helm values, Kustomize patch에 평문 시크릿 값이 없는가?
- [ ] Docker build context와 컨테이너 이미지 레이어에 `.env`, 인증서, private key, token 파일이 포함되지 않는가?
- [ ] 민감 값의 원본이 Secrets Manager 또는 Parameter Store 같은 외부 저장소로 이동되었는가?
- [ ] 워크로드에는 실제 값 대신 Secret 이름, key, ARN, parameter path 같은 참조만 남아 있는가?
- [ ] Pod 주입 방식이 ESO, Secrets Store CSI Driver, SDK 조회 중 하나로 명확히 정의되어 있는가?
- [ ] 외부 시크릿 접근 권한이 IRSA 또는 Pod Identity로 최소 권한만 부여되어 있는가?
- [ ] Kubernetes Secret을 사용하는 경우 etcd 암호화와 RBAC 접근 통제가 적용되어 있는가?
- [ ] 이미 노출된 시크릿을 새 값으로 로테이션했는가?
- [ ] Git 히스토리, CI/CD 로그, 이미지 레지스트리에서 기존 시크릿 노출 범위를 확인했는가?
- [ ] 배포 후 애플리케이션이 외부 참조 기반으로 정상 동작하고 로그에 시크릿을 출력하지 않는가?

