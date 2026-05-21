# kubelet API 접근을 노드 보안 그룹 경계로 제한한다

> **Phase:** Efficient (효율화)
>
> **보안 영역:** 네트워크 보안
>
> **담당:** 공통 (전체 실습)
>
> **난이도:** ★★☆

---

## 왜 필요한가

kubelet은 각 Worker Node에서 실행되는 Kubernetes 에이전트다. API Server에서 할당된 Pod를 실행하고, containerd 같은 컨테이너 런타임과 통신하며, Node와 Pod 상태를 API Server에 보고한다. 또한 `kubectl logs`, `kubectl exec`, `kubectl attach`, `kubectl port-forward`, metrics-server의 리소스 수집처럼 노드와 컨테이너에 직접 닿는 기능도 kubelet API를 통해 처리된다.

kubelet API의 대표 포트는 다음과 같다.

| 포트 | 용도 | 보안 기준 |
| --- | --- | --- |
| `10250/tcp` | kubelet HTTPS API | EKS Control Plane, metrics-server 등 필요한 주체만 접근 |
| `10255/tcp` | kubelet read-only API | 비활성화 또는 네트워크 미노출 |

노드 보안 그룹이 과도하게 열려 있으면 외부 또는 불필요한 내부 네트워크에서 kubelet API에 접근할 수 있다. 특히 `10250`이 `0.0.0.0/0`, VPN CIDR, VPC 전체 CIDR 등으로 직접 열려 있거나, `10255`가 남아 있으면 Node/Pod 정보 노출과 노드 단위 공격면 확대로 이어질 수 있다.

EKS 기본 구성에서는 노드가 EKS cluster security group을 공유하고, 해당 보안 그룹에 self-referencing all traffic 규칙이 존재할 수 있다. 이 상태는 인터넷에 kubelet API가 직접 열린 것은 아니지만, 같은 cluster security group이 붙은 리소스끼리는 `10250`을 포함한 모든 포트 통신이 가능하다. 따라서 Efficient 단계에서는 노드 전용 보안 그룹을 두고 kubelet API 접근 경계를 명시적으로 줄인다.

이 항목의 목표는 다음과 같다.

- kubelet HTTPS API `10250`은 EKS cluster security group에서만 접근하도록 제한한다.
- kubelet read-only API `10255`는 보안 그룹에서 열지 않는다.
- 노드가 private EKS API endpoint `443`에는 계속 접근할 수 있게 한다.
- 보안 그룹 규칙과 실제 노드 연결 상태를 명령어로 검증한다.

## 수행 방법

**사전 조건**

- EKS 클러스터, managed node group, 보안 그룹을 수정할 수 있는 IAM 권한이 필요하다.
  - 예: `eks:DescribeCluster`, `eks:DescribeNodegroup`, `eks:UpdateNodegroupVersion`, `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`
- `kubectl`이 EKS API Server에 인증되어 있어야 한다.
- Terraform으로 EKS 모듈과 infra 환경을 관리하고 있어야 한다.
- metrics-server를 사용 중이라면 적용 후 `kubectl top` 동작을 함께 검증해야 한다.

### **Step 1: 적용 전 kubelet API 노출 상태를 확인한다**

실습 환경 기준 변수는 다음처럼 둔다.

```bash
export AWS_PROFILE=eks-security-infra
export AWS_REGION=ap-northeast-2
export CLUSTER_NAME=eks-secure-infra-dev
export NODEGROUP_NAME=eks-secure-infra-dev-spot
```

EKS cluster security group을 확인한다.

```bash
CLUSTER_SG_ID="$(aws eks describe-cluster \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --name "${CLUSTER_NAME}" \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' \
  --output text)"

echo "${CLUSTER_SG_ID}"
```

cluster security group의 kubelet 관련 포트와 self rule을 확인한다.

```bash
aws ec2 describe-security-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --group-ids "${CLUSTER_SG_ID}" \
  --query 'SecurityGroups[].IpPermissions' \
  --output json
```

적용 전 실습 환경에서는 다음과 같은 self-referencing all traffic 규칙이 확인되었다.

```json
{
  "IpProtocol": "-1",
  "UserIdGroupPairs": [
    {
      "GroupId": "sg-015841da165f32250"
    }
  ],
  "IpRanges": []
}
```

이 규칙은 같은 cluster security group이 붙은 리소스 간 모든 포트 통신을 허용한다. 외부 CIDR에 kubelet API가 열린 것은 아니지만, kubelet `10250` 접근 경계가 노드 전용 보안 그룹 기준으로 분리되어 있지 않은 상태다.

노드 인스턴스와 연결된 보안 그룹도 확인한다. zsh에서는 공백으로 나열된 인스턴스 ID가 자동 분리되지 않으므로 `${=INSTANCE_IDS}`를 사용한다.

```bash
ASG_NAME="$(aws eks describe-nodegroup \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODEGROUP_NAME}" \
  --query 'nodegroup.resources.autoScalingGroups[0].name' \
  --output text)"

INSTANCE_IDS="$(aws autoscaling describe-auto-scaling-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" \
  --query 'AutoScalingGroups[0].Instances[].InstanceId' \
  --output text)"

aws ec2 describe-instances \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --instance-ids ${=INSTANCE_IDS} \
  --query 'Reservations[].Instances[].SecurityGroups[]' \
  --output table
```

노드 보안 그룹에서 `10250`, `10255` 인바운드 규칙을 조회한다.

```bash
NODE_SG_IDS="$(aws ec2 describe-instances \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --instance-ids ${=INSTANCE_IDS} \
  --query 'Reservations[].Instances[].SecurityGroups[].GroupId' \
  --output text)"

aws ec2 describe-security-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --group-ids ${=NODE_SG_IDS} \
  --query 'SecurityGroups[].{GroupId:GroupId,Ingress:IpPermissions[?FromPort==`10250` || ToPort==`10250` || FromPort==`10255` || ToPort==`10255`]}' \
  --output json
```

적용 전 결과가 다음과 같다면 노드 보안 그룹에서 kubelet 포트를 직접 열지는 않은 상태다.

```json
[
  {
    "GroupId": "sg-015841da165f32250",
    "Ingress": []
  }
]
```

다만 cluster security group self rule이 있으면 같은 SG가 붙은 리소스 사이에서는 모든 포트가 허용될 수 있으므로, 이 실습에서는 노드 전용 SG로 kubelet 접근 경계를 명시화한다.

### **Step 2: EKS 모듈에 노드 전용 보안 그룹을 만든다**

EKS 모듈은 노드 보안 그룹을 생성하기 위해 VPC ID를 입력받는다.

```hcl
variable "vpc_id" {
  description = "VPC ID where the EKS managed node security group is created."
  type        = string
}
```

infra 환경에서는 VPC 모듈 output을 EKS 모듈로 전달한다.

```hcl
module "eks" {
  source = "../../modules/eks"

  project_name = var.project_name
  environment  = var.environment
  owner        = var.owner
  vpc_id       = module.vpc.vpc_id

  cluster_subnet_ids = module.vpc.private_subnet_ids
  node_subnet_ids    = module.vpc.private_subnet_ids
}
```

노드 전용 보안 그룹은 다음처럼 만든다.

```hcl
resource "aws_security_group" "node" {
  name_prefix            = "${local.node_group_name}-"
  description            = "Restrict EKS managed node ingress, including kubelet API access"
  vpc_id                 = var.vpc_id
  revoke_rules_on_delete = true

  tags = merge(
    local.common_tags,
    {
      Name    = "${local.node_group_name}-sg"
      Role    = "eks-node"
      Purpose = "kubelet-api-restricted"
    }
  )
}
```

### **Step 3: kubelet HTTPS API는 cluster security group에서만 허용한다**

EKS Control Plane이 kubelet `10250`에 접근할 수 있도록, 노드 보안 그룹에는 cluster security group을 source로 하는 ingress만 추가한다.

```hcl
resource "aws_security_group_rule" "node_kubelet_https_from_cluster" {
  type                     = "ingress"
  security_group_id        = aws_security_group.node.id
  protocol                 = "tcp"
  from_port                = 10250
  to_port                  = 10250
  source_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  description              = "Allow kubelet HTTPS API only from the EKS control plane security group"
}
```

cluster security group 쪽 egress도 명시한다.

```hcl
resource "aws_security_group_rule" "cluster_kubelet_https_to_nodes" {
  type                     = "egress"
  security_group_id        = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  protocol                 = "tcp"
  from_port                = 10250
  to_port                  = 10250
  source_security_group_id = aws_security_group.node.id
  description              = "Allow EKS control plane egress to managed node kubelet HTTPS API"
}
```

노드가 private EKS API endpoint에 접근할 수 있도록 cluster security group에 node SG 기준 `443` ingress도 추가한다.

```hcl
resource "aws_security_group_rule" "cluster_private_endpoint_from_nodes" {
  type                     = "ingress"
  security_group_id        = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  protocol                 = "tcp"
  from_port                = 443
  to_port                  = 443
  source_security_group_id = aws_security_group.node.id
  description              = "Allow managed nodes to reach the private EKS API endpoint"
}
```

노드 간 통신과 AWS API 접근에 필요한 기본 규칙은 별도로 둔다.

```hcl
resource "aws_security_group_rule" "node_inter_node" {
  type              = "ingress"
  security_group_id = aws_security_group.node.id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  self              = true
  description       = "Allow managed nodes to communicate with each other"
}

resource "aws_security_group_rule" "node_egress" {
  type              = "egress"
  security_group_id = aws_security_group.node.id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow managed nodes to reach required AWS APIs and registries"
}
```

### **Step 4: managed node group Launch Template에 전용 SG를 연결한다**

Launch Template에 노드 전용 보안 그룹을 연결한다.

```hcl
resource "aws_launch_template" "node_group" {
  name_prefix            = "${local.node_group_name}-"
  update_default_version = true
  vpc_security_group_ids = [aws_security_group.node.id]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
}
```

managed node group은 보안 그룹 규칙 생성 이후 업데이트되도록 의존성을 둔다.

```hcl
resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = local.node_group_name

  launch_template {
    id      = aws_launch_template.node_group.id
    version = aws_launch_template.node_group.latest_version
  }

  depends_on = [
    aws_security_group_rule.cluster_kubelet_https_to_nodes,
    aws_security_group_rule.cluster_private_endpoint_from_nodes,
    aws_security_group_rule.node_egress,
    aws_security_group_rule.node_inter_node,
    aws_security_group_rule.node_kubelet_https_from_cluster,
  ]
}
```

감사와 운영 점검을 위해 노드 보안 그룹 ID를 output으로 노출한다.

```hcl
output "node_security_group_id" {
  description = "Security group attached to the default managed node group."
  value       = aws_security_group.node.id
}
```

### **Step 5: Terraform으로 적용한다**

먼저 테스트와 plan을 실행한다.

```bash
python -m unittest tests.test_kubelet_api_security

terraform -chdir=modules/eks test \
  -filter=tests/minimal-cluster.tftest.hcl

terraform -chdir=environments/infra plan -out=tfplan
```

계획에 다음 변경이 포함되는지 확인한다.

```text
+ aws_security_group.node
+ aws_security_group_rule.node_kubelet_https_from_cluster
+ aws_security_group_rule.cluster_private_endpoint_from_nodes
+ aws_security_group_rule.cluster_kubelet_https_to_nodes
~ aws_launch_template.node_group
~ aws_eks_node_group.this
```

문제가 없으면 적용한다.

```bash
terraform -chdir=environments/infra apply tfplan
```

노드 그룹이 `ACTIVE`가 아닌 상태에서 업데이트를 시도하면 다음 오류가 날 수 있다.

```text
ResourceInUseException: Nodegroup cannot be updated as it is currently not in Active State
```

이 경우 노드 그룹이 `ACTIVE`가 될 때까지 기다린 뒤, 기존 plan을 버리고 새 plan으로 다시 적용한다.

```bash
aws eks wait nodegroup-active \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODEGROUP_NAME}"

terraform -chdir=environments/infra plan -out=tfplan
terraform -chdir=environments/infra apply tfplan
```

## 검증 방법

### **1. 노드 그룹이 새 Launch Template을 사용하는지 확인한다**

```bash
aws eks describe-nodegroup \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODEGROUP_NAME}" \
  --query 'nodegroup.{status:status,launchTemplate:launchTemplate,health:health.issues}' \
  --output json
```

기대 결과는 `status`가 `ACTIVE`이고 `health` issue가 없는 것이다.

### **2. 실제 노드에 연결된 보안 그룹을 확인한다**

```bash
ASG_NAME="$(aws eks describe-nodegroup \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODEGROUP_NAME}" \
  --query 'nodegroup.resources.autoScalingGroups[0].name' \
  --output text)"

INSTANCE_IDS="$(aws autoscaling describe-auto-scaling-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" \
  --query 'AutoScalingGroups[0].Instances[].InstanceId' \
  --output text)"

aws ec2 describe-instances \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --instance-ids ${=INSTANCE_IDS} \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,SecurityGroups:SecurityGroups}' \
  --output json
```

노드에 새 전용 보안 그룹이 연결되어 있어야 한다.

### **3. kubelet API 포트 규칙을 확인한다**

```bash
NODE_SG_IDS="$(aws ec2 describe-instances \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --instance-ids ${=INSTANCE_IDS} \
  --query 'Reservations[].Instances[].SecurityGroups[].GroupId' \
  --output text)"

aws ec2 describe-security-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --group-ids ${=NODE_SG_IDS} \
  --query 'SecurityGroups[].{GroupId:GroupId,Ingress:IpPermissions[?FromPort==`10250` || ToPort==`10250` || FromPort==`10255` || ToPort==`10255`]}' \
  --output json
```

기대 결과는 다음과 같다.

- `10250`은 cluster security group을 source로 하는 규칙만 존재한다.
- `10250`에 `0.0.0.0/0`, `::/0`, VPC 전체 CIDR, VPN 전체 CIDR이 직접 source로 들어가 있지 않다.
- `10255`를 여는 ingress 규칙이 없다.

더 좁게 `10255`만 확인한다.

```bash
aws ec2 describe-security-groups \
  --profile "${AWS_PROFILE}" \
  --region "${AWS_REGION}" \
  --group-ids ${=NODE_SG_IDS} \
  --query 'SecurityGroups[].IpPermissions[?FromPort==`10255` || ToPort==`10255`]' \
  --output json
```

기대 결과:

```json
[]
```

### **4. 클러스터 기능이 유지되는지 확인한다**

kubelet 접근을 제한한 후에도 노드 상태와 metrics-server 기능은 유지되어야 한다.

```bash
kubectl get nodes -o wide

kubectl get pods -n kube-system -l k8s-app=metrics-server

kubectl top nodes
kubectl top pods -A
```

`kubectl top`이 실패하면 metrics-server가 kubelet `10250`에 접근하지 못하는 상태일 수 있다. metrics-server 로그와 배포 인자를 확인한다.

```bash
kubectl -n kube-system logs deploy/metrics-server --tail=100

kubectl -n kube-system get deploy metrics-server \
  -o jsonpath='{.spec.template.spec.containers[0].args}'
```

### **5. 코드 레벨 회귀 테스트를 실행한다**

```bash
python -m unittest tests.test_kubelet_api_security

terraform -chdir=modules/eks test \
  -filter=tests/minimal-cluster.tftest.hcl

terraform fmt -check \
  modules/eks/main.tf \
  modules/eks/variables.tf \
  modules/eks/outputs.tf \
  environments/infra/main.tf \
  environments/infra/outputs.tf \
  modules/eks/tests/minimal-cluster.tftest.hcl
```

## Risk 및 미적용 시 영향

- **공격 시나리오:** 공격자가 같은 VPC 또는 같은 cluster security group이 붙은 리소스에 접근한 뒤 kubelet `10250`으로 노드 API 접근을 시도한다. 인증/인가가 약하거나 kubelet serving 설정이 잘못되어 있으면 Pod 정보 조회, 로그 접근, exec 계열 기능 악용으로 이어질 수 있다.
- **정보 노출:** kubelet API는 Node, Pod, 컨테이너 상태와 로그 같은 민감한 운영 정보를 다룬다. 불필요한 네트워크에서 도달 가능하면 침해 조사 전에 정보 수집 경로가 된다.
- **권한 상승 가능성:** kubelet 인증/인가 설정, 노드 IAM 권한, 컨테이너 런타임 설정이 함께 약하면 노드 단위 권한 상승의 발판이 될 수 있다.
- **운영 영향:** `10250`을 필요한 주체까지 차단하면 API Server의 logs/exec/port-forward, metrics-server 수집이 실패할 수 있다. 따라서 차단이 아니라 필요한 control plane 경로만 명시 허용해야 한다.
- **심각도:** **높음** — kubelet API는 노드와 컨테이너 관리면에 가깝기 때문에 네트워크 노출을 최소화해야 한다.

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 공통 실습, 네트워크 보안 담당자 검토 |
| 예상 소요 시간 | 적용 전 점검 30분 + Terraform 변경 1시간 + 노드 교체/검증 1시간 |
| AWS 추가 비용 | 보안 그룹 자체 추가 비용 없음 |
| 운영 비용 | managed node group rolling update 시간, 노드 재생성 중 Pod 재스케줄링 영향 확인 필요 |
| 도구 비용 | Terraform, AWS CLI, kubectl 사용 시 별도 도구 비용 없음 |

운영 환경에서는 PodDisruptionBudget, 노드 그룹 desired capacity, 중요 워크로드 분산 상태를 확인한 뒤 node group update를 수행해야 한다. 실습 환경에서도 노드 교체 중 일시적으로 Pod가 재시작될 수 있다.

## Assessment 체크리스트

- [ ] 노드 보안 그룹에서 `10250`이 `0.0.0.0/0`, `::/0`, VPC/VPN 전체 CIDR로 열려 있지 않은가?
- [ ] kubelet `10250` ingress source가 EKS cluster security group으로 제한되어 있는가?
- [ ] kubelet read-only port `10255` ingress 규칙이 없는가?
- [ ] 노드 전용 보안 그룹이 managed node group Launch Template에 연결되어 있는가?
- [ ] 노드가 private EKS API endpoint `443`에 정상 접근할 수 있는가?
- [ ] `kubectl logs`, `kubectl exec`, `kubectl top nodes`, `kubectl top pods`가 정상 동작하는가?
- [ ] Terraform test와 Python 회귀 테스트가 kubelet API 보안 경계를 검증하는가?
- [ ] 노드 그룹 업데이트 후 상태가 `ACTIVE`이고 health issue가 없는가?

## 참고 자료

- [Amazon EKS security group requirements and considerations](https://docs.aws.amazon.com/eks/latest/userguide/sec-group-reqs.html)
- [Amazon EKS launch templates](https://docs.aws.amazon.com/eks/latest/userguide/launch-templates.html)
- [Kubernetes kubelet](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [Kubernetes Node authorization](https://kubernetes.io/docs/reference/access-authn-authz/node/)
- [Kubernetes Kubelet authentication/authorization](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-authn-authz/)
- [Metrics Server](https://github.com/kubernetes-sigs/metrics-server)
