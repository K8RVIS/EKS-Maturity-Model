# Cluster Resource 사용을 제한한다

> **Phase:** Quick Wins
>
> **보안 영역:** Pod 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★☆☆

---

## 왜 필요한가

Kubernetes 클러스터는 여러 팀과 서비스가 같은 노드 풀, API 서버, 스케줄러, kubelet 자원을 공유한다. 특정 Pod가 CPU를 과도하게 사용하거나 메모리 누수로 계속 확장되면 해당 Pod만 느려지는 것이 아니라 같은 노드의 다른 Pod까지 지연, 재시작, OOMKilled 상태로 이어질 수 있다. 이런 "noisy neighbor" 문제는 악의적인 DoS가 아니어도 잘못된 배포 설정이나 무한 루프만으로 발생한다.

EKS에서도 기본 동작은 같다. 네임스페이스에 `ResourceQuota`가 없으면 팀별 총 사용량 상한이 없고, Pod나 컨테이너에 `resources.requests`와 `resources.limits`가 없으면 스케줄러가 필요한 용량을 정확히 계산하기 어렵다. 그 결과 한 팀의 테스트 워크로드가 노드 자원을 잠식하거나, HPA와 Cluster Autoscaler가 예측하기 어려운 방향으로 동작할 수 있다.

이 항목의 목표는 다음 두 가지다.

- 네임스페이스 단위로 CPU/Memory 총량 상한을 둔다.
- 개별 Pod가 리소스 값을 생략해도 기본 request/limit이 적용되도록 한다.

팀이 각자 `requests`와 `limits`를 잘 설정하도록 권장하는 것만으로는 충분하지 않다. 사람은 설정을 쉽게 누락하고, 반대로 특정 팀이 지나치게 큰 request/limit을 선언하면 클러스터의 공용 자원을 과도하게 점유할 수 있다. 따라서 워크로드 매니페스트에는 서비스별 값을 명시하되, 클러스터 운영자는 네임스페이스 레벨의 `ResourceQuota`와 `LimitRange`로 최소한의 강제선을 함께 둬야 한다.

---

## 수행 방법

**사전 조건**

- `kubectl`로 대상 EKS 클러스터와 네임스페이스에 접근할 수 있어야 한다.
- 팀 또는 서비스별 네임스페이스가 분리되어 있어야 한다. 예: `team-a`, `team-b`, `team-c`, `team-d`
- 각 워크로드의 평상시 CPU/Memory 사용량과 최대 사용량을 대략 파악해야 한다. Metrics Server, CloudWatch Container Insights, Prometheus 같은 관측 데이터가 있으면 더 정확하다.
- GitOps 또는 Kustomize로 관리하는 환경이라면 라이브 패치보다 원본 매니페스트에 `ResourceQuota`와 `LimitRange`를 추가한다.

### Step 1: 현재 리소스 요청과 제한 상태를 확인한다

먼저 네임스페이스에 quota와 limitrange가 이미 있는지 확인한다.

```bash
kubectl get resourcequota,limitrange -n team-a
kubectl describe resourcequota -n team-a
kubectl describe limitrange -n team-a
```

워크로드의 컨테이너별 request/limit 설정도 확인한다.

```bash
kubectl get pods -n team-a \
  -o custom-columns='POD:.metadata.name,CONTAINER:.spec.containers[*].name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory,CPU_LIMIT:.spec.containers[*].resources.limits.cpu,MEM_LIMIT:.spec.containers[*].resources.limits.memory'
```

미적용 상태는 다음과 같다.

- `No resources found`로 `ResourceQuota`와 `LimitRange`가 없다.
- 컨테이너의 `CPU_REQ`, `MEM_REQ`, `CPU_LIMIT`, `MEM_LIMIT`가 비어 있다.
- 특정 네임스페이스에서 생성 가능한 Pod 수, PVC 수, Secret 수 등에 상한이 없다.

### Step 2: ResourceQuota와 LimitRange의 역할을 분리해서 설계한다

두 리소스는 서로 대체재가 아니라 보완재다.

| 리소스 | 제한 범위 | 막을 수 있는 문제 | 단독 사용 시 한계 |
| --- | --- | --- | --- |
| `ResourceQuota` | 네임스페이스 전체 총합 | 팀 또는 서비스 네임스페이스가 클러스터 자원을 과도하게 점유하는 상황 | 단일 Pod 또는 단일 컨테이너가 네임스페이스 quota 대부분을 혼자 쓰는 상황을 세밀하게 막기 어렵다. |
| `LimitRange` | 네임스페이스 내 개별 컨테이너 또는 Pod | 리소스 설정 누락, 컨테이너별 과도한 request/limit 선언 | 네임스페이스 전체 총합 사용량을 제한하지 못한다. |

`ResourceQuota`만 적용하면 네임스페이스 총량은 제한되지만, 어떤 Pod가 그 총량을 대부분 가져가는 설계 오류를 막기 어렵다. 또한 CPU/Memory quota가 있는 네임스페이스에서는 새 Pod가 request 또는 limit을 명시하지 않으면 생성이 거부될 수 있다. 이때 `LimitRange`로 기본 request/limit을 주입하면 설정 누락으로 인한 배포 실패를 줄일 수 있다.

반대로 `LimitRange`만 적용하면 개별 컨테이너의 최대값은 제한되지만, 같은 네임스페이스에서 많은 Pod를 생성해 총합으로 자원을 소진하는 상황을 막기 어렵다. 따라서 멀티팀 EKS 환경에서는 두 리소스를 함께 적용하는 것을 기본값으로 둔다.

### Step 3: 네임스페이스별 ResourceQuota를 정의한다

`ResourceQuota`는 네임스페이스 전체의 총 request, 총 limit, 오브젝트 개수 상한을 제한한다. 아래 예시는 한 팀 실습 네임스페이스에 낮은 비용으로 적용할 수 있는 시작점이다. 실제 운영 값은 서비스 중요도, 노드 크기, 팀별 할당 정책에 맞게 조정한다.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-resource-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    pods: "20"
    services: "10"
    persistentvolumeclaims: "5"
```

| 항목 | 의미 |
| --- | --- |
| `requests.cpu`, `requests.memory` | 네임스페이스 내 모든 Pod가 예약할 수 있는 CPU/Memory request 총합 |
| `limits.cpu`, `limits.memory` | 네임스페이스 내 모든 Pod가 선언할 수 있는 CPU/Memory limit 총합 |
| `pods` | 생성 가능한 Pod 수 상한 |
| `services` | 생성 가능한 Service 수 상한 |
| `persistentvolumeclaims` | 생성 가능한 PVC 수 상한 |

```bash
kubectl apply -f namespace-resource-quota.yaml
```

### Step 4: 기본 request/limit을 적용하는 LimitRange를 정의한다

`LimitRange`는 컨테이너가 리소스 값을 생략했을 때 기본 request/limit을 채우고, 개별 컨테이너가 설정할 수 있는 최소/최대값을 제한한다.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: default-container-limits
  namespace: team-a
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      default:
        cpu: 500m
        memory: 512Mi
      min:
        cpu: 50m
        memory: 64Mi
      max:
        cpu: "1"
        memory: 1Gi
```

이 설정은 새로 생성되는 컨테이너에 다음 기준을 적용한다.

- request가 없으면 `cpu: 100m`, `memory: 128Mi`를 기본값으로 넣는다.
- limit이 없으면 `cpu: 500m`, `memory: 512Mi`를 기본값으로 넣는다.
- 개별 컨테이너는 최대 `cpu: 1`, `memory: 1Gi`를 넘을 수 없다.

```bash
kubectl apply -f default-container-limits.yaml
```

`LimitRange`는 기존 Pod를 자동으로 수정하지 않는다. 이미 떠 있는 Pod는 재배포해야 새 기본값이 적용된다.

### Step 5: 값을 관측 기반으로 산정한다

quota와 limit을 너무 낮게 잡으면 정상 트래픽에서도 CPU throttling, OOMKilled, Pending Pod가 발생할 수 있다. 반대로 너무 높게 잡으면 예약 자원이 커져 노드 사용률이 낮아지고 불필요한 비용이 증가한다.

1. Metrics Server, Container Insights, Prometheus 등으로 실제 CPU/Memory 사용량을 관찰한다.
2. 대상 네임스페이스의 현재 사용량을 확인하고, 가능하면 7일 이상 peak와 평상시 사용량을 비교한다.
3. 개발 네임스페이스에는 낮은 quota와 엄격한 max limit을 적용해 실험 워크로드의 확산을 막는다.
4. 프로덕션 네임스페이스에는 트래픽 급증과 배포 여유를 고려해 더 느슨한 quota를 적용하되, 사용률 알람과 정기 리뷰를 함께 둔다.
5. OOMKilled, CPU throttling, Pending Pod가 반복되면 애플리케이션 문제인지 정책값 문제인지 구분해 조정한다.

```bash
# 현재 컨테이너별 리소스 사용량 확인
kubectl top pods --containers -n team-a

# OOMKilled 또는 Evicted 이벤트 확인
kubectl get events -n team-a --sort-by='.lastTimestamp' \
  | grep -E 'OOMKilled|Evicted|FailedScheduling|exceeded quota'
```

### Step 6: 워크로드 매니페스트에 명시적 resources를 추가한다

`LimitRange` 기본값은 안전망으로 두고, 운영 워크로드에는 가능한 한 명시적으로 `resources`를 선언한다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: team-a
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.27.5
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

`api`와 `db`도 동일하게 기본 request/limit을 둔다. 특히 Redis 같은 상태 저장 워크로드는 메모리 limit을 너무 낮게 잡으면 OOMKilled가 반복될 수 있으므로, 실제 데이터 크기와 eviction 정책을 함께 검토한다.

### Step 7: Kustomize overlay에 quota와 limitrange를 포함한다

GitOps 기준으로는 팀 overlay마다 정책 매니페스트를 두고 `kustomization.yaml`에 포함한다.

```yaml
# eks-secure-infra/manifests/overlays/team-a/resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-resource-quota
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    pods: "20"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: default-container-limits
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      default:
        cpu: 500m
        memory: 512Mi
      max:
        cpu: "1"
        memory: 1Gi
```

```yaml
# eks-secure-infra/manifests/overlays/team-a/kustomization.yaml
namespace: team-a

resources:
  - ../../base
  - resource-quota.yaml
```

`team-b`, `team-c`, `team-d`도 같은 방식으로 적용하되, 환경별 정책 차이가 있다면 overlay 단위로 값을 분리한다.

---

## 검증 방법

정책이 생성되었는지 확인한다.

```bash
kubectl get resourcequota,limitrange -n team-a
kubectl describe resourcequota namespace-resource-quota -n team-a
kubectl describe limitrange default-container-limits -n team-a
```

기대 결과:

- `namespace-resource-quota`의 hard 값에 CPU/Memory request와 limit 총량이 표시된다.
- `default-container-limits`에 기본 request/limit과 max 값이 표시된다.
- `Used` 값이 워크로드 생성에 따라 증가한다.

리소스를 생략한 Pod에 기본값이 들어가는지 확인한다.

```bash
kubectl run limitrange-test \
  -n team-a \
  --image=busybox:1.36 \
  --restart=Never \
  -- sleep 3600

kubectl get pod limitrange-test -n team-a -o yaml \
  | grep -A5 'resources:'
```

기대 결과: Pod spec에 `LimitRange`가 지정한 request와 limit이 자동으로 채워진다.

할당량 초과 시 Pod 생성이 차단되는지 확인한다.

```yaml
# over-quota-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: over-quota
  namespace: team-a
spec:
  containers:
    - name: stress
      image: busybox:1.36
      command: ["sleep", "3600"]
      resources:
        requests:
          cpu: "3"
          memory: 5Gi
        limits:
          cpu: "5"
          memory: 10Gi
```

```bash
kubectl apply -f over-quota-pod.yaml
```

기대 결과:

```text
Error from server (Forbidden): error when creating "over-quota-pod.yaml": pods "over-quota" is forbidden: exceeded quota: namespace-resource-quota
```

quota 사용량을 확인하고 테스트 Pod를 정리한다.

```bash
kubectl describe quota namespace-resource-quota -n team-a
kubectl delete pod limitrange-test -n team-a --ignore-not-found
```

**검증 완료 기준**

- `ResourceQuota`와 `LimitRange`가 모든 팀 네임스페이스에 적용되어 있다.
- 리소스 생략 Pod에 기본값이 자동으로 채워진다.
- quota 초과 Pod 생성이 `Forbidden` 오류로 차단된다.

---

## Risk 및 미적용 시 영향

- **공격 시나리오:** 공격자 또는 오작동한 사용자가 리소스 제한이 없는 Pod를 대량 생성하거나, CPU를 계속 사용하는 프로세스를 실행해 같은 노드의 다른 서비스 성능을 저하시킨다.
- **설정 오류 시나리오:** 애플리케이션 메모리 누수, 무한 루프, 잘못된 batch job 병렬도 설정으로 인해 특정 네임스페이스가 클러스터 자원을 과점한다.
- **운영 리스크:** quota와 limit을 너무 낮게 잡으면 정상 Pod도 Pending, OOMKilled, CPU throttling 상태가 될 수 있다. 정책은 한 번 정하고 끝내는 값이 아니라 관측 데이터 기반으로 조정해야 한다.
- **영향 범위:** 같은 노드 또는 같은 클러스터의 인접 서비스 지연, OOMKilled, 스케줄링 실패, autoscaling 비용 증가, 장애 원인 분석 지연
- **심각도:** **중간** — 권한 탈취나 데이터 유출보다 직접적인 보안 영향은 낮을 수 있지만, 멀티테넌트 클러스터에서는 가용성 장애로 빠르게 확산될 수 있다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼 운영 담당자 |
| 예상 소요 시간 | 정책 초안 작성 30분 + 적용/검증 30분 |
| AWS 추가 비용 | 없음. 단, request/limit을 현실적으로 조정하면 필요한 노드 용량이 명확해져 비용 계획이 바뀔 수 있다. |
| 도구 비용 | 없음. Kubernetes 기본 리소스 사용 |
| 운영 고려사항 | 너무 낮은 quota는 정상 배포를 막고, 너무 높은 quota는 보호 효과가 약하다. 초기에는 보수적으로 적용한 뒤 관측 데이터 기반으로 조정한다. |

---

## Assessment 체크리스트

- [ ] 모든 팀 또는 서비스 네임스페이스에 `ResourceQuota`가 적용되어 있는가?
- [ ] 모든 팀 또는 서비스 네임스페이스에 기본 `LimitRange`가 적용되어 있는가?
- [ ] 주요 워크로드 컨테이너에 CPU/Memory request와 limit이 명시되어 있는가?
- [ ] quota 초과 Pod 생성이 `Forbidden` 오류로 차단되는 것을 테스트했는가?
- [ ] 개발/스테이징/프로덕션 네임스페이스의 quota 강도가 환경 특성에 맞게 다르게 설정되어 있는가?
- [ ] CPU throttling, OOMKilled, Pending Pod, quota 초과 이벤트를 관측하고 값 조정 기준을 정했는가?
- [ ] quota 값이 실제 사용량과 서비스 중요도에 맞게 주기적으로 조정되는가?

---

## 참고 자료

- [Kubernetes 공식 문서 - Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Kubernetes 공식 문서 - Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Kubernetes 공식 문서 - Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Google Cloud Blog - Kubernetes best practices: resource requests and limits](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-resource-requests-and-limits?hl=en)
- [EKS Best Practices Guides - Reliability](https://aws.github.io/aws-eks-best-practices/reliability/)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  네임스페이스별 ResourceQuota 적용을 권고하며, 클러스터 자원 공유 환경에서 팀 간 자원 격리를 통제하도록 요구한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너별 CPU/Memory limit 설정을 권고하며, 자원 고갈 공격과 noisy neighbor 문제를 방지하기 위해 네임스페이스 수준의 정책 적용을 요구한다.
- **AWS EKS Best Practices**
  멀티테넌트 환경에서 ResourceQuota와 LimitRange를 함께 적용해 팀 간 자원 격리를 보장하고, Cluster Autoscaler와의 예측 가능한 연동을 위해 request/limit 명시를 권장한다.
