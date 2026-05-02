# Namespace별 ResourceQuota와 LimitRange를 적용한다

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

현재 `eks-vulnerable-infra` 실습 기준선에서도 이 위험을 확인할 수 있다. [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/web/deployment.yaml)과 [deployment.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/web/deployment.yaml)은 컨테이너에 CPU/Memory request와 limit을 지정하지 않는다. [statefulset.yaml](https://github.com/K8RVIS/eks-secure-infra/blob/main/manifests/base/db/statefulset.yaml)은 PVC storage request만 있고 컨테이너 CPU/Memory 제한은 없다.

팀이 각자 `requests`와 `limits`를 잘 설정하도록 권장하는 것만으로는 충분하지 않다. 사람은 설정을 쉽게 누락하고, 반대로 특정 팀이 지나치게 큰 request/limit을 선언하면 클러스터의 공용 자원을 과도하게 점유할 수 있다. 따라서 워크로드 매니페스트에는 서비스별 값을 명시하되, 클러스터 운영자는 네임스페이스 레벨의 `ResourceQuota`와 `LimitRange`로 최소한의 강제선을 함께 둬야 한다.

## 수행 방법

**사전 조건**

- `kubectl`로 대상 EKS 클러스터와 네임스페이스에 접근할 수 있어야 한다.
- 팀 또는 서비스별 네임스페이스가 분리되어 있어야 한다. 예: `team-a`, `team-b`, `team-c`, `team-d`
- 각 워크로드의 평상시 CPU/Memory 사용량과 최대 사용량을 대략 파악해야 한다. Metrics Server, CloudWatch Container Insights, Prometheus 같은 관측 데이터가 있으면 더 정확하다.
- `modules/namespaces`를 통해 네임스페이스를 생성하는 Terraform 환경이 있어야 한다.

**Step 1: 현황을 파악한다**

적용 전에 네임스페이스에 quota와 limitrange가 이미 있는지, 워크로드의 컨테이너에 request/limit이 설정되어 있는지 확인한다.

```bash
kubectl get resourcequota,limitrange -n <namespace>
kubectl describe resourcequota -n <namespace>
kubectl describe limitrange -n <namespace>
```

워크로드의 컨테이너별 request/limit 설정도 확인한다.

```bash
kubectl get pods -n <namespace> \
  -o custom-columns='POD:.metadata.name,CONTAINER:.spec.containers[*].name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory,CPU_LIMIT:.spec.containers[*].resources.limits.cpu,MEM_LIMIT:.spec.containers[*].resources.limits.memory'
```

미적용 상태에서 확인할 수 있는 문제점은 다음과 같다.

- `No resources found`로 `ResourceQuota`와 `LimitRange`가 없다.
- 컨테이너의 `CPU_REQ`, `MEM_REQ`, `CPU_LIMIT`, `MEM_LIMIT`가 비어 있다.
- 특정 네임스페이스에서 생성 가능한 Pod 수에 상한이 없다.

**Step 2: ResourceQuota와 LimitRange의 역할을 분리해서 이해한다**

두 리소스는 서로 대체재가 아니라 보완재다.

| 리소스 | 제한 범위 | 막을 수 있는 문제 | 단독 사용 시 한계 |
| --- | --- | --- | --- |
| `ResourceQuota` | 네임스페이스 전체 총합 | 팀 또는 서비스 네임스페이스가 클러스터 자원을 과도하게 점유하는 상황 | 단일 Pod가 네임스페이스 quota 대부분을 혼자 쓰는 상황을 세밀하게 막기 어렵다. |
| `LimitRange` | 네임스페이스 내 개별 컨테이너 | 리소스 설정 누락, 컨테이너별 과도한 request/limit 선언 | 네임스페이스 전체 총합 사용량을 제한하지 못한다. |

`ResourceQuota`만 적용하면 CPU/Memory quota가 있는 네임스페이스에서 새 Pod가 request 또는 limit을 명시하지 않으면 생성이 거부될 수 있다. 이때 `LimitRange`로 기본 request/limit을 주입하면 설정 누락으로 인한 배포 실패를 줄일 수 있다. 멀티팀 EKS 환경에서는 두 리소스를 함께 적용하는 것을 기본값으로 둔다.

**Step 3: Terraform 모듈에 ResourceQuota와 LimitRange를 정의한다**

`ResourceQuota`와 `LimitRange`는 Terraform `modules/namespaces/main.tf`에서 네임스페이스 생성과 함께 정의한다. 이 방식은 인프라 레이어에서 강제하는 가드레일로, `kubectl delete`로 삭제해도 다음 `terraform apply`에서 재생성된다.

```hcl
resource "kubernetes_resource_quota" "teams" {
  for_each = kubernetes_namespace_v1.teams

  metadata {
    name      = "team-quota"
    namespace = each.value.metadata[0].name
  }

  spec {
    hard = {
      "requests.cpu"    = "1"
      "limits.cpu"      = "2"
      "requests.memory" = "1Gi"
      "limits.memory"   = "2Gi"
      "pods"            = "10"
    }
  }
}

resource "kubernetes_limit_range" "teams" {
  for_each = kubernetes_namespace_v1.teams

  metadata {
    name      = "team-limit-range"
    namespace = each.value.metadata[0].name
  }

  spec {
    limit {
      type = "Container"
      default = {
        cpu    = "500m"
        memory = "256Mi"
      }
      default_request = {
        cpu    = "100m"
        memory = "128Mi"
      }
    }
  }
}
```

`for_each = kubernetes_namespace_v1.teams`로 모든 팀 네임스페이스에 동일한 정책이 자동 적용된다. 적용은 platform 환경에서 실행한다.

```bash
cd environments/platform
terraform init
terraform apply
```

ResourceQuota 항목별 의미는 다음과 같다.

| 항목 | 의미 |
| --- | --- |
| `requests.cpu`, `requests.memory` | 네임스페이스 내 모든 Pod가 예약할 수 있는 CPU/Memory request 총합 |
| `limits.cpu`, `limits.memory` | 네임스페이스 내 모든 Pod가 선언할 수 있는 CPU/Memory limit 총합 |
| `pods` | 생성 가능한 Pod 수 상한 |

LimitRange의 `default`는 컨테이너가 limit을 생략했을 때 자동으로 채워지는 값이고, `default_request`는 request를 생략했을 때 채워지는 값이다. `LimitRange`는 기존 Pod를 자동으로 수정하지 않으며, 이미 떠 있는 Pod는 재배포해야 새 기본값이 적용된다.

**Step 4: 값을 관측 기반으로 산정한다**

quota와 limit을 너무 낮게 잡으면 정상 트래픽에서도 CPU throttling, OOMKilled, Pending Pod가 발생할 수 있다. 반대로 너무 높게 잡으면 예약 자원이 커져 노드 사용률이 낮아지고 불필요한 비용이 증가한다.

따라서 처음부터 강한 차단 정책을 적용하기보다 다음 순서로 조정한다.

1. Metrics Server, Container Insights, Prometheus 등으로 실제 CPU/Memory 사용량을 관찰한다.
2. `kubectl top pods --containers -n <namespace>`로 대상 네임스페이스의 현재 사용량을 확인하고, 가능하면 7일 이상 peak와 평상시 사용량을 비교한다.
3. 개발 네임스페이스에는 낮은 quota와 엄격한 기본 limit을 적용해 실험 워크로드의 확산을 막는다.
4. 프로덕션 네임스페이스에는 트래픽 급증과 배포 여유를 고려해 더 느슨한 quota를 적용하되, 사용률 알람과 정기 리뷰를 함께 둔다.
5. OOMKilled, CPU throttling, Pending Pod가 반복되면 애플리케이션 문제인지 정책값 문제인지 구분해 조정한다.

```bash
# 현재 컨테이너별 리소스 사용량 확인
kubectl top pods --containers -n <namespace>

# OOMKilled 또는 quota 초과 이벤트 확인
kubectl get events -n <namespace> --sort-by='.lastTimestamp' \
  | grep -E 'OOMKilled|Evicted|FailedScheduling|exceeded quota'
```

**Step 5: 워크로드 매니페스트에 명시적 resources를 추가한다**

`LimitRange` 기본값은 안전망으로 두고, 운영 워크로드에는 가능한 한 명시적으로 `resources`를 선언한다. 그래야 코드 리뷰와 용량 계획에서 서비스별 의도를 확인할 수 있다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
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
              memory: 256Mi
```

특히 Redis 같은 상태 저장 워크로드는 메모리 limit을 너무 낮게 잡으면 OOMKilled가 반복될 수 있으므로, 실제 데이터 크기와 eviction 정책을 함께 검토한다.

> **참고: Kustomize overlay 방식**
>
> Terraform 모듈 대신 각 팀 overlay에 직접 `ResourceQuota`와 `LimitRange` 매니페스트를 두는 방식도 가능하다. `manifests/overlays/<namespace>/resource-controls.yaml`을 생성하고 `kustomization.yaml`에 포함하면 된다. 이 방식은 팀마다 다른 quota 값을 독립적으로 유지할 수 있고 변경이 워크로드 매니페스트와 같은 레이어에서 관리된다. 다만 `kubectl delete`로 직접 삭제하면 다음 GitOps 동기화 전까지 공백이 생길 수 있어, Terraform 방식보다 우회가 쉽다.
>

**Terraform 방식 vs Kustomize overlay 방식 비교**

ResourceQuota와 LimitRange를 적용하는 방식은 크게 두 가지다. 환경과 운영 정책에 따라 선택하거나 혼용할 수 있다.

| 항목 | Terraform 방식 | Kustomize overlay 방식 |
| --- | --- | --- |
| 적용 위치 | `modules/namespaces/main.tf` | `manifests/overlays/<namespace>/resource-controls.yaml` |
| 적용 방법 | `terraform apply` | `kubectl apply` / GitOps 동기화 |
| 관리 주체 | 플랫폼 팀 (인프라 레이어) | 각 팀 (매니페스트 레이어) |
| 정책 범위 | 모듈을 사용하는 모든 네임스페이스에 동일 적용 | overlay 단위로 팀별 값 독립 설정 가능 |
| 우회 가능성 | `kubectl delete` 후 `terraform apply`로 재생성됨 | GitOps 동기화 전까지 공백 발생 가능 |
| 변경 이력 | 인프라 PR을 통해 관리, 변경 추적 명확 | 워크로드 매니페스트와 같은 레이어에서 가시성 높음 |
| 팀별 커스터마이징 | 모듈 변수로 일부 가능, 기본적으로 통일된 값 | 팀마다 완전히 다른 quota/limit 설정 가능 |

**선택 기준**

- **Terraform 방식이 적합한 경우:** 플랫폼 팀이 quota 정책을 중앙에서 강제해야 하는 경우, 팀이 정책을 임의로 변경하거나 삭제하지 못하도록 인프라 레이어에서 보장이 필요한 경우
- **Kustomize overlay 방식이 적합한 경우:** 팀마다 서비스 규모와 자원 요구사항이 크게 달라 개별 조정이 필요한 경우, 워크로드와 정책을 같은 레이어에서 함께 관리하고 싶은 경우
- **혼용:** Terraform으로 모든 네임스페이스에 최솟값(하한 가드레일)을 강제하고, 팀이 overlay에서 추가 제약을 얹는 방식도 가능하다.

## 검증 방법

정책이 생성되었는지 확인한다.

```bash
kubectl get resourcequota,limitrange -n <namespace>
kubectl describe resourcequota team-quota -n <namespace>
kubectl describe limitrange team-limit-range -n <namespace>
```

기대 결과:

- `team-quota`의 hard 값에 CPU/Memory request와 limit 총량이 표시된다.
- `team-limit-range`에 기본 request/limit 값이 표시된다.
- `Used` 값이 워크로드 생성에 따라 증가한다.

리소스를 생략한 Pod에 기본값이 들어가는지 확인한다.

```bash
kubectl run limitrange-test \
  -n <namespace> \
  --image=busybox:1.36 \
  --restart=Never \
  -- sleep 3600

kubectl get pod limitrange-test -n <namespace> -o yaml \
  | grep -A 5 'resources:'
```

기대 결과는 Pod spec에 `LimitRange`가 지정한 request(`cpu: 100m`, `memory: 128Mi`)와 limit(`cpu: 500m`, `memory: 256Mi`)이 자동으로 채워지는 것이다.

할당량 초과 시 Pod 생성이 차단되는지 확인한다. Deployment replica를 quota의 pod 상한인 10개를 넘도록 스케일 아웃한다.

```bash
kubectl scale deployment web -n <namespace> --replicas=15
kubectl get pods -n <namespace>
kubectl get events -n <namespace> --sort-by='.lastTimestamp' | grep 'exceeded quota'
```

기대 결과는 10개를 초과하는 Pod가 `Pending` 상태로 남고, 이벤트에 `exceeded quota` 메시지가 표시되는 것이다.

```text
Error from server (Forbidden): pods "web-xxxx" is forbidden: exceeded quota: team-quota
```

검증 후 테스트 Pod와 replica를 원래대로 정리한다.

```bash
kubectl delete pod limitrange-test -n <namespace> --ignore-not-found
kubectl scale deployment web -n <namespace> --replicas=<원래 값>
```

검증 완료 기준은 다음과 같다.

- `team-quota`와 `team-limit-range`가 모든 팀 네임스페이스에 존재한다.
- 리소스를 생략한 Pod에 기본 request/limit이 자동으로 채워진다.
- quota 상한을 초과하는 Pod 생성이 `Forbidden` 오류로 차단된다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** 공격자 또는 오작동한 사용자가 리소스 제한이 없는 Pod를 대량 생성하거나, CPU를 계속 사용하는 프로세스를 실행해 같은 노드의 다른 서비스 성능을 저하시킨다.
- **설정 오류 시나리오:** 애플리케이션 메모리 누수, 무한 루프, 잘못된 batch job 병렬도 설정으로 인해 특정 네임스페이스가 클러스터 자원을 과점한다.
- **운영 리스크:** quota와 limit을 너무 낮게 잡으면 정상 Pod도 Pending, OOMKilled, CPU throttling 상태가 될 수 있다. 정책은 한 번 정하고 끝내는 값이 아니라 관측 데이터 기반으로 조정해야 한다.
- **영향 범위:** 같은 노드 또는 같은 클러스터의 인접 서비스 지연, OOMKilled, 스케줄링 실패, autoscaling 비용 증가, 장애 원인 분석 지연
- **심각도:** **중간** — 권한 탈취나 데이터 유출보다 직접적인 보안 영향은 낮을 수 있지만, 멀티테넌트 클러스터에서는 가용성 장애로 빠르게 확산될 수 있다.

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습 또는 플랫폼 운영 담당자 |
| 예상 소요 시간 | 정책 초안 작성 30분 + 적용/검증 30분 |
| AWS 추가 비용 | 없음. 단, request/limit을 현실적으로 조정하면 필요한 노드 용량이 명확해져 비용 계획이 바뀔 수 있다. |
| 도구 비용 | 없음. Kubernetes 기본 리소스 사용 |
| 운영 고려사항 | 너무 낮은 quota는 정상 배포를 막고, 너무 높은 quota는 보호 효과가 약하다. 초기에는 보수적으로 적용한 뒤 관측 데이터 기반으로 조정한다. |

## 참고 자료

- [Kubernetes 공식 문서 - Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Kubernetes 공식 문서 - Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Kubernetes 공식 문서 - Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Google Cloud Blog - Kubernetes best practices: resource requests and limits](https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-resource-requests-and-limits?hl=en)
- [EKS Best Practices Guides - Reliability](https://aws.github.io/aws-eks-best-practices/reliability/)

## 연계된 보안 가이드라인 항목

이 항목은 아래 보안 기준과 직접 연결된다.

- **CIS Kubernetes Benchmark v1.12.0**
  네임스페이스별 ResourceQuota 적용은 멀티테넌트 클러스터에서 자원 격리와 노이지 네이버 방지를 위한 운영 통제와 연결된다.
- **NSA/CISA Kubernetes Hardening Guidance**
  CPU/Memory request와 limit 설정을 통해 단일 워크로드의 자원 독점을 방지하고 클러스터 안정성을 유지하도록 권고한다.
- **AWS EKS Best Practices**
  멀티테넌트 환경에서 ResourceQuota와 LimitRange를 조합해 네임스페이스별 자원 격리를 구성하는 것을 권장한다.

## Assessment 체크리스트

- [ ] 모든 팀 또는 서비스 네임스페이스에 `ResourceQuota`가 적용되어 있는가?
- [ ] 모든 팀 또는 서비스 네임스페이스에 기본 `LimitRange`가 적용되어 있는가?
- [ ] Terraform을 통해 중앙에서 배포되며, 개별 작업자가 임의로 리소스를 변경/삭제할 수 없도록 RBAC 권한 분리가 엄격히 설정되어 있는가?
- [ ] 주요 워크로드 컨테이너에 CPU/Memory request와 limit이 명시되어 있는가?
- [ ] quota 초과 Pod 생성이 `Forbidden` 오류로 차단되는 것을 테스트했는가?
- [ ] 리소스를 생략한 Pod에 `LimitRange` 기본값이 자동으로 채워지는 것을 확인했는가?
- [ ] CPU throttling, OOMKilled, Pending Pod, quota 초과 이벤트를 관측하고 값 조정 기준을 정했는가?
- [ ] quota 값이 실제 사용량과 서비스 중요도에 맞게 주기적으로 조정되는가?
