---
title: "컨테이너를 non-root 사용자로 실행하고 루트 파일시스템 쓰기를 제한한다"
description: "왜 필요한가"
phase: "Quick Wins"
domain: "컨테이너 보안"
difficulty: "★☆☆"
owner: "공통 (전체 실습)"
order: 20
sidebar:
  order: 20
---

#### 왜 필요한가

컨테이너 이미지는 별도 설정이 없으면 root 사용자로 실행되는 경우가 많다. 컨테이너 런타임과 커널 격리가 있더라도, 컨테이너 내부 프로세스가 UID 0 권한을 가지면 침해 사고가 발생했을 때 피해 범위가 커진다.

예를 들어 공격자가 웹 애플리케이션 취약점이나 원격 코드 실행 취약점을 통해 Pod 내부 쉘을 획득했다고 가정한다. 해당 컨테이너가 root로 실행 중이면 공격자는 컨테이너 내부 파일을 자유롭게 수정하고, 패키지 매니저나 다운로드 도구를 이용해 악성 도구를 설치하거나, 잘못 마운트된 볼륨과 민감 파일에 접근할 가능성이 높아진다. 특히 `hostPath`, 과도한 Linux capability, privileged 컨테이너, 서비스 계정 토큰 노출 같은 다른 취약한 설정과 결합되면 호스트 접근 또는 클러스터 내 권한 상승으로 이어질 수 있다.

따라서 컨테이너는 기본적으로 다음 원칙을 따라야 한다.

- 이미지 빌드 단계에서 non-root 사용자로 실행되도록 `USER`를 지정한다.
- Kubernetes Pod 또는 컨테이너의 `securityContext`에서 root 실행을 차단한다.
- 애플리케이션이 루트 파일시스템을 수정하지 못하도록 `readOnlyRootFilesystem: true`를 적용한다.
- 쓰기가 꼭 필요한 경로는 `emptyDir`, PVC 등 명시적인 쓰기 볼륨으로 분리한다.

현재 `eks-secure-infra` 실습 환경의 insecure baseline에서도 이 위험을 확인할 수 있다. [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/web/deployment.yaml#L25)에는 아래와 같이 `web` 컨테이너가 root 사용자로 실행되도록 설정되어 있다.

```yaml
securityContext:
  runAsNonRoot: false
  runAsUser: 0
```

이 항목의 목표는 컨테이너가 root 권한에 의존하지 않도록 바꾸고, 침해 이후 공격자가 컨테이너 내부 상태를 마음대로 변경하기 어렵게 만드는 것이다.

#### 수행 방법

**사전 조건**

- 대상 애플리케이션이 root 권한 없이 실행 가능한지 확인해야 한다.
- 애플리케이션이 쓰는 경로를 확인해야 한다. 예: `/tmp`, `/var/cache`, `/var/log`, 업로드 디렉터리
- 자체 이미지를 빌드한다면 Dockerfile을 수정할 수 있어야 한다.
- 상용 또는 외부 이미지를 쓴다면 해당 이미지가 non-root 실행을 지원하는지 확인해야 한다.

**Step 1: Dockerfile에서 non-root 사용자로 전환한다**

가능하면 이미지 자체가 root 없이 동작하도록 만든다. Kubernetes에서 강제로 UID를 바꾸는 것보다, 빌드 시점부터 파일 소유권과 실행 권한을 맞추는 편이 운영 중 장애를 줄인다.

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=10001:10001 . .

RUN addgroup -g 10001 appgroup \
  && adduser -D -u 10001 -G appgroup appuser

USER 10001:10001

EXPOSE 3000
CMD ["node", "server.js"]
```

이미지가 파일을 쓰는 경로가 있다면 해당 경로의 소유권도 non-root 사용자에게 맞춘다.

```dockerfile
RUN mkdir -p /app/tmp \
  && chown -R 10001:10001 /app/tmp
```

**Step 2: Deployment에 non-root 실행을 명시한다**

Pod template에 `securityContext`를 선언해 기본 실행 UID/GID를 지정하고, 컨테이너 레벨에서 루트 파일시스템 읽기 전용과 권한 상승 차단을 함께 적용한다.

`readOnlyRootFilesystem`은 Pod 레벨이 아니라 컨테이너 `securityContext` 필드에 설정해야 한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: team-a
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: <account-id>.dkr.ecr.ap-northeast-2.amazonaws.com/web:<tag>
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
```

핵심 필드는 다음과 같이 이해하면 된다.

| 필드 | 목적 |
| --- | --- |
| `runAsNonRoot: true` | UID 0으로 실행되는 컨테이너 시작을 거부 |
| `runAsUser: 10001` | 컨테이너 프로세스 실행 UID를 명시 |
| `runAsGroup: 10001` | 컨테이너 프로세스 실행 GID를 명시 |
| `readOnlyRootFilesystem: true` | 컨테이너 루트 파일시스템 쓰기 차단 |
| `allowPrivilegeEscalation: false` | setuid, setgid 등을 통한 권한 상승 차단 |
| `capabilities.drop: ["ALL"]` | 기본 Linux capability를 제거해 공격면 축소 |
| `seccompProfile.type: RuntimeDefault` | 런타임 기본 seccomp 프로필 적용 |

**Step 3: 쓰기가 필요한 경로만 별도 볼륨으로 분리한다**

루트 파일시스템을 읽기 전용으로 바꾸면 `/tmp`, `/var/cache/nginx`, `/var/run` 같은 경로에 쓰는 애플리케이션이 실패할 수 있다. 이 경우 루트 파일시스템 전체를 쓰기 가능하게 되돌리지 말고, 필요한 경로만 `emptyDir` 또는 PVC로 분리한다.

예를 들어 NGINX 기반 컨테이너에서 임시 파일과 캐시 경로가 필요하다면 다음처럼 선언한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: team-a
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
        fsGroup: 101
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: nginxinc/nginx-unprivileged:1.27
          ports:
            - containerPort: 8080
              name: http
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: nginx-cache
              mountPath: /var/cache/nginx
            - name: nginx-run
              mountPath: /var/run
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: nginx-cache
          emptyDir: {}
        - name: nginx-run
          emptyDir: {}
        - name: tmp
          emptyDir: {}
```

외부 공개용 샘플에서는 root로 80 포트에 바인딩하는 이미지보다, 8080 등 비특권 포트를 사용하는 non-root 이미지를 선택하는 편이 단순하다.

**Step 4: Pod Security Admission으로 재발을 방지한다**

개별 Deployment를 수정하는 것만으로는 새 워크로드가 다시 root로 배포되는 것을 막기 어렵다. 네임스페이스에는 Kubernetes Pod Security Admission을 적용해 `restricted` 기준을 강제하거나, 먼저 `warn`/`audit`로 영향도를 확인한 뒤 `enforce`로 전환한다.

```bash
# 영향도 확인 단계
kubectl label namespace team-a \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted \
  --overwrite

# 강제 적용 단계
kubectl label namespace team-a \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  --overwrite
```

운영 환경에서는 컨트롤러, CNI, CSI, 관측 도구처럼 특권이 필요한 시스템 워크로드를 애플리케이션 네임스페이스와 분리하고, 예외 네임스페이스는 별도 기준으로 관리해야 한다.

**Step 5: eks-secure-infra에 수동으로 반영한다**

현재 저장소 기준으로는 [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/web/deployment.yaml#L25)의 `web` Deployment가 가장 직접적인 적용 포인트다.

권장 반영 순서는 다음과 같다.

1. `nginx:1.27.5` 이미지가 root 실행과 80 포트 바인딩에 의존하는지 확인한다.
2. 실습 목적상 안전한 기준선을 만들려면 `nginxinc/nginx-unprivileged` 같은 non-root 지원 이미지를 사용하거나, 자체 Dockerfile에서 non-root 사용자와 비특권 포트를 구성한다.
3. `runAsNonRoot: true`, `runAsUser`/`runAsGroup`에 0이 아닌 UID/GID를 명시한다.
4. 컨테이너 `securityContext`에 `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`을 추가한다.
5. 쓰기가 필요한 경로만 `emptyDir`로 열고, 서비스 포트와 컨테이너 포트를 함께 조정한다.

#### 검증 방법

먼저 매니페스트가 의도한 보안 컨텍스트를 갖는지 확인한다.

```bash
# Pod 레벨 securityContext 확인
kubectl get deploy web -n team-a \
  -o jsonpath='{.spec.template.spec.securityContext}{"\n"}'

# 컨테이너 레벨 securityContext 확인
kubectl get deploy web -n team-a \
  -o jsonpath='{.spec.template.spec.containers[0].securityContext}{"\n"}'
```

기대 결과에는 아래 값이 포함되어야 한다.

```json
{"runAsNonRoot":true,"runAsUser":10001,"runAsGroup":10001}
{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true}
```

실행 중인 컨테이너가 root가 아닌지 확인한다.

```bash
kubectl exec -n team-a deploy/web -- id
```

기대 결과는 `uid=0(root)`가 아니라 `uid=10001`처럼 0이 아닌 UID가 표시되는 것이다.

루트 파일시스템 쓰기가 차단되는지 확인한다.

```bash
kubectl exec -n team-a deploy/web -- sh -c 'touch /root-test'
```

기대 결과는 다음과 유사한 오류다.

```text
touch: /root-test: Read-only file system
```

쓰기 허용 경로를 별도 볼륨으로 분리했다면 해당 경로만 쓰기가 되는지도 함께 확인한다.

```bash
kubectl exec -n team-a deploy/web -- sh -c 'touch /tmp/write-test && ls -l /tmp/write-test'
```

Pod Security Admission을 적용했다면 root 실행 Pod가 거부되는지도 확인한다.

```bash
kubectl run root-test -n team-a \
  --image=busybox:1.36 \
  --overrides='{"spec":{"containers":[{"name":"root-test","image":"busybox:1.36","command":["sleep","3600"],"securityContext":{"runAsUser":0}}]}}'
```

`restricted` 정책이 `enforce`로 적용된 네임스페이스에서는 root 실행 또는 필수 보안 컨텍스트 누락으로 인해 Pod 생성이 거부되어야 한다.

#### Risk 및 미적용 시 영향

- **공격 시나리오 예시:** 공격자가 취약한 `web` 컨테이너에서 쉘을 획득한 뒤 root 권한으로 파일을 수정하고, 악성 바이너리를 내려받거나 런타임 설정을 변경해 지속성을 확보한다.
- **영향 범위:** 컨테이너 내부 변조, 민감 파일 접근, 잘못 마운트된 볼륨 변조, 서비스 계정 토큰 및 환경변수 탈취, 다른 취약한 설정과 결합된 노드 또는 클러스터 권한 상승 가능성
- **심각도:** **높음**. root 실행 자체만으로 즉시 호스트 root를 얻는 것은 아니지만, 컨테이너 탈출 취약점이나 과도한 capability, privileged 설정, hostPath 마운트와 결합되면 피해 범위가 크게 확대된다.

#### 인적 리소스 및 비용

- **담당자 및 예상 소요 시간:** 플랫폼 엔지니어 또는 애플리케이션 담당자 1명 기준으로 워크로드 1개당 점검 30분~1시간, 이미지 수정이 필요한 경우 빌드/테스트 포함 1~3시간
- **AWS 비용 발생 여부 및 예상 규모:** 없음. Kubernetes 기본 보안 컨텍스트와 매니페스트 수정만으로 적용 가능
- **오픈소스 vs 상용 도구 선택 시 비용 차이:** 필수 비용 없음. 정책 검증 자동화가 필요하면 Kyverno, OPA Gatekeeper 같은 오픈소스 정책 엔진을 추가로 사용할 수 있다.

#### 참고 자료

- [Amazon EKS Best Practices - Identity and Access Management](https://docs.aws.amazon.com/ko_kr/eks/latest/best-practices/identity-and-access-management.html#_identities_and_credentials_for_eks_pods_recommendations)
- [Kubernetes - Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [Kubernetes - Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [CIS Kubernetes Benchmark v1.12.0](../CIS_Kubernetes_Benchmark_V1.12.0_PDF.md)
- [NSA/CISA Kubernetes Hardening Guidance](../CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.md)

#### 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  `5.2.7 Minimize the admission of root containers`
  컨테이너가 root 사용자로 실행되는 것을 일반적으로 허용하지 말고, `MustRunAsNonRoot` 또는 UID 0을 제외한 범위 정책을 사용하도록 권고한다.
- **Kubernetes Pod Security Standards**
  `Restricted` 프로파일은 non-root 실행, privilege escalation 제한, capability 축소, seccomp 적용 등 일반 애플리케이션 워크로드에 필요한 강한 기본 보안 기준을 제공한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `Non-root containers and rootless container engines`
  컨테이너 애플리케이션을 non-root 사용자로 빌드하고 실행하도록 권고하며, Kubernetes `securityContext`뿐 아니라 이미지 빌드 단계에서 non-root 실행을 통합하는 것이 더 높은 보증을 제공한다고 설명한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  `Appendix B: Example deployment template for read-only file system`
  컨테이너의 루트 파일시스템을 읽기 전용으로 설정하고, 쓰기가 필요한 위치만 별도 볼륨으로 제공하는 패턴을 제시한다.

#### Assessment 체크리스트

- [ ] Dockerfile 또는 베이스 이미지가 non-root 사용자 실행을 지원하는가?
- [ ] Deployment 또는 Pod에 `runAsNonRoot: true`가 설정되어 있는가?
- [ ] `runAsUser`와 `runAsGroup`이 0이 아닌 UID/GID로 명시되어 있는가?
- [ ] 컨테이너에 `readOnlyRootFilesystem: true`가 설정되어 있는가?
- [ ] 컨테이너에 `allowPrivilegeEscalation: false`와 `capabilities.drop: ["ALL"]`이 적용되어 있는가?
- [ ] 애플리케이션이 쓰는 경로가 루트 파일시스템이 아니라 명시적인 볼륨으로 분리되어 있는가?
- [ ] `kubectl exec -- id` 결과가 `uid=0(root)`가 아님을 확인했는가?
- [ ] 루트 파일시스템 쓰기 시도 시 `Read-only file system` 오류가 발생하는가?
- [ ] 네임스페이스에 Pod Security Admission `restricted` 기준을 `warn`/`audit` 또는 `enforce`로 적용했는가?

