---
title: "Worker node와 Pod를 private subnet에 배치한다"
description: "왜 필요한가"
phase: "Foundational"
domain: "네트워크 보안"
difficulty: "미정"
owner: "공통 (전체 실습)"
order: 20
sidebar:
  order: 20
---

## 왜 필요한가

EKS Worker node는 실제 Pod가 실행되는 데이터 플레인이다. Worker node가 Public Subnet에 배치되거나 Public IP를 직접 가지면 인터넷에서 노드의 네트워크 경계까지 도달할 수 있는 공격면이 생긴다. 인증, Security Group, NACL, OS hardening이 있더라도 불필요한 public 노출은 스캐닝, 취약한 데몬 공격, 잘못 열린 관리 포트, Security Group 오구성의 영향을 키운다.

Pod도 마찬가지다. AWS VPC CNI를 사용하는 EKS에서는 Pod IP가 VPC subnet 대역에서 할당되므로, Worker node와 Pod가 놓이는 subnet 설계가 클러스터 네트워크 보안의 기본 경계가 된다. 일반적인 운영 구성에서는 외부 진입점과 outbound 중계 계층만 Public Subnet에 두고, Worker node와 Pod는 Private Subnet에 배치한다.

이 실습의 목표 구성은 다음과 같다.

- Internet-facing ALB 또는 NLB만 Public Subnet에 배치한다.
- outbound 인터넷 접근이 필요할 때는 NAT Gateway 대신 실습 환경의 `fck-nat` instance를 Public Subnet에 둔다.
- EKS control plane 연결 subnet과 managed node group subnet은 Private Subnet을 사용한다.
- Public Route Table은 `0.0.0.0/0 -> IGW`를 사용한다.
- Private Route Table은 `0.0.0.0/0 -> fck-nat primary ENI`를 사용한다.

현재 `eks-security-infra` 실습에서는 [environments/infra/main.tf](https://github.com/K8RVIS/eks-security-infra/blob/main/environments/infra/main.tf)의 EKS 모듈 입력값을 통해 이 통제를 적용한다.

```hcl
module "eks" {
  source = "../../modules/eks"

  cluster_subnet_ids                    = module.vpc.private_subnet_ids
  node_subnet_ids                       = module.vpc.private_subnet_ids
  cluster_private_endpoint_access_cidrs = var.cluster_private_endpoint_access_cidrs
}
```

## 수행 방법

### 사전 조건

- VPC와 EKS 리소스를 수정할 수 있는 IAM 권한이 필요하다.
  - 예: `ec2:DescribeSubnets`, `ec2:DescribeRouteTables`, `eks:DescribeNodegroup`, `eks:UpdateNodegroupConfig`
- Terraform state에 접근할 수 있어야 한다.
- 기존 managed node group의 subnet 변경은 node 교체 또는 node group 재생성이 발생할 수 있으므로, `terraform plan`에서 영향을 반드시 확인해야 한다.
- Private Subnet의 outbound 경로가 준비되어 있어야 한다.
  - 이 실습에서는 NAT Gateway가 아니라 `fck-nat` instance의 primary network interface를 사용한다.
- EKS API endpoint가 private-only인 경우, `kubectl` 실행 위치가 VPC 내부 또는 연결된 사설망이어야 한다.

### Step 1: 현재 subnet과 node group 배치를 확인한다

먼저 Terraform output으로 Public/Private Subnet ID를 확인한다.

```bash
cd environments/infra

terraform output public_subnet_ids
terraform output private_subnet_ids
```

이미 새 output을 추가했지만 아직 `terraform apply`를 하지 않았다면 다음 명령은 실패할 수 있다.

```bash
terraform output node_subnet_ids
```

예상 가능한 오류:

```text
Error: Output "node_subnet_ids" not found
```

이 오류는 현재 `.tf` 파일 문제가 아니라 state에 새 output이 아직 기록되지 않았다는 뜻이다. `terraform output`은 현재 코드가 아니라 마지막 `terraform apply`로 저장된 state를 조회한다.

AWS API로 실제 managed node group subnet을 확인한다.

```bash
export AWS_REGION=ap-northeast-2
export CLUSTER_NAME=$(terraform output -raw cluster_name)
export NODE_GROUP_NAME=$(terraform output -raw node_group_name)

aws eks describe-nodegroup \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODE_GROUP_NAME}" \
  --query 'nodegroup.subnets' \
  --output table
```

취약한 상태는 node group subnet이 `public_subnet_ids`와 겹치는 경우다.

### Step 2: Worker node의 Public IP 보유 여부를 확인한다

Worker node EC2 instance가 Public IP를 가지고 있는지 확인한다.

```bash
aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --filters \
    "Name=tag:eks:cluster-name,Values=${CLUSTER_NAME}" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,SubnetId:SubnetId,PrivateIp:PrivateIpAddress,PublicIp:PublicIpAddress}' \
  --output table
```

미적용 또는 취약한 상태는 다음과 같다.

- `SubnetId`가 Public Subnet ID에 포함된다.
- `PublicIp`가 비어 있지 않다.
- node group subnet이 Public Subnet으로 설정되어 있다.

### Step 3: Private Subnet route가 `fck-nat`을 향하는지 확인한다

이 실습 환경은 NAT Gateway가 아니라 `fck-nat` instance를 outbound 중계 계층으로 사용한다. 따라서 Private Route Table의 default route는 NAT Gateway ID가 아니라 `fck-nat`의 primary network interface ID를 향해야 한다.

```bash
export VPC_ID=$(terraform output -raw vpc_id)

aws ec2 describe-route-tables \
  --region "${AWS_REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" \
  --query 'RouteTables[].{RouteTableId:RouteTableId,Associations:Associations[].SubnetId,Routes:Routes[].{Destination:DestinationCidrBlock,Gateway:GatewayId,NatGateway:NatGatewayId,NetworkInterface:NetworkInterfaceId}}' \
  --output table
```

기대하는 구조는 다음과 같다.

| Subnet 유형 | Default route |
| --- | --- |
| Public Subnet | `0.0.0.0/0 -> Internet Gateway` |
| Private Subnet | `0.0.0.0/0 -> fck-nat primary ENI` |

### Step 4: Terraform 코드에서 EKS subnet 입력을 Private Subnet으로 고정한다

`environments/infra/main.tf`의 EKS 모듈 호출에서 control plane과 node group 모두 Private Subnet을 사용하도록 설정한다.

```hcl
module "eks" {
  source = "../../modules/eks"

  project_name                          = var.project_name
  environment                           = var.environment
  owner                                 = var.owner
  cluster_subnet_ids                    = module.vpc.private_subnet_ids
  node_subnet_ids                       = module.vpc.private_subnet_ids
  cluster_private_endpoint_access_cidrs = var.cluster_private_endpoint_access_cidrs
  kubernetes_version                    = var.kubernetes_version
  node_ami_type                         = var.node_ami_type
  node_group                            = var.node_group
  default_tags                          = var.default_tags
}
```

`modules/vpc`는 `fck-nat`을 Public Subnet에 배치하고, Private Route Table의 default route를 `fck-nat` ENI로 설정한다.

```hcl
resource "aws_route" "private_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.fck_nat.primary_network_interface_id
}
```

### Step 5: Terraform plan을 확인하고 적용한다

node group subnet 변경은 실제 node 교체를 유발할 수 있으므로 반드시 plan을 먼저 확인한다.

```bash
cd environments/infra

terraform plan -out=tfplan
terraform show -no-color tfplan | rg "subnet_ids|endpoint_private_access|endpoint_public_access|cluster_private_endpoint|node_group"
```

의도한 변경이라면 적용한다.

```bash
terraform apply tfplan
```

`terraform apply -refresh-only`로 output만 state에 넣는 방식은 사용하지 않는다. 실제 node group 배치가 바뀌지 않았는데 output만 Private Subnet처럼 보일 수 있어 이 통제 검증에는 부적절하다.

## 검증 방법

### Terraform test로 코드 레벨 통제를 검증한다

```bash
cd environments/infra
terraform fmt -check
terraform validate
terraform test
```

```bash
cd ../../modules/vpc
terraform fmt -check
terraform validate
terraform test
```

```bash
cd ../eks
terraform fmt -check
terraform validate
terraform test
```

기대 결과는 모든 테스트가 `Success!`로 종료되는 것이다. 특히 다음 테스트가 통과해야 한다.

- `environments/infra/tests/private-subnet-placement.tftest.hcl`
  - EKS control plane subnet IDs가 Private Subnet IDs와 같은지 확인한다.
  - managed node group subnet IDs가 Private Subnet IDs와 같은지 확인한다.
- `modules/vpc/tests/network-layout.tftest.hcl`
  - Private Subnet default route가 `fck-nat` primary ENI를 향하는지 확인한다.
- `modules/eks/tests/minimal-cluster.tftest.hcl`
  - EKS node group test fixture가 Private Subnet 배치를 검증한다.

### Terraform output으로 적용 결과를 확인한다

적용 후에는 새 output이 state에 기록되어야 한다.

```bash
cd environments/infra

terraform output public_subnet_ids
terraform output private_subnet_ids
terraform output cluster_subnet_ids
terraform output node_subnet_ids
terraform output fck_nat_subnet_id
terraform output fck_nat_primary_network_interface_id
terraform output private_default_route_network_interface_id
```

기대 결과:

- `cluster_subnet_ids`가 `private_subnet_ids`와 일치한다.
- `node_subnet_ids`가 `private_subnet_ids`와 일치한다.
- `fck_nat_subnet_id`는 `public_subnet_ids` 중 하나다.
- `private_default_route_network_interface_id`가 `fck_nat_primary_network_interface_id`와 일치한다.

### AWS API로 실제 node 배치를 확인한다

```bash
export AWS_REGION=ap-northeast-2
export CLUSTER_NAME=$(terraform output -raw cluster_name)
export NODE_GROUP_NAME=$(terraform output -raw node_group_name)

aws eks describe-nodegroup \
  --region "${AWS_REGION}" \
  --cluster-name "${CLUSTER_NAME}" \
  --nodegroup-name "${NODE_GROUP_NAME}" \
  --query 'nodegroup.subnets' \
  --output table
```

기대 결과:

- 출력된 subnet ID가 `terraform output private_subnet_ids`에 포함된다.
- 출력된 subnet ID가 `terraform output public_subnet_ids`에 포함되지 않는다.

Worker node EC2 instance도 확인한다.

```bash
aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --filters \
    "Name=tag:eks:cluster-name,Values=${CLUSTER_NAME}" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].{InstanceId:InstanceId,SubnetId:SubnetId,PrivateIp:PrivateIpAddress,PublicIp:PublicIpAddress}' \
  --output table
```

기대 결과:

- `SubnetId`가 Private Subnet ID에 포함된다.
- `PublicIp`가 `None`이거나 비어 있다.
- `PrivateIp`는 존재한다.

Kubernetes 관점에서는 node가 내부 IP 기준으로 동작하는지 확인한다.

```bash
kubectl get nodes -o wide
```

기대 결과:

- node의 Internal IP가 표시된다.
- AWS EC2 조회 결과상 node instance에 Public IP가 없다.

### Ingress와 Load Balancer subnet 배치를 확인한다

AWS Load Balancer Controller를 사용하는 경우 subnet tag에 따라 internet-facing ALB는 Public Subnet에, internal ALB는 Private Subnet에 생성되어야 한다.

```bash
aws ec2 describe-subnets \
  --region "${AWS_REGION}" \
  --subnet-ids $(terraform output -json public_subnet_ids | jq -r '.[]') \
  --query 'Subnets[].{SubnetId:SubnetId,Tags:Tags}' \
  --output json
```

Public Subnet에는 다음 tag가 있어야 한다.

```text
kubernetes.io/role/elb = 1
```

Private Subnet에는 다음 tag가 있어야 한다.

```text
kubernetes.io/role/internal-elb = 1
```

Load Balancer scheme도 확인한다.

```bash
aws elbv2 describe-load-balancers \
  --region "${AWS_REGION}" \
  --query 'LoadBalancers[].{Name:LoadBalancerName,Scheme:Scheme,VpcId:VpcId,AvailabilityZones:AvailabilityZones[].SubnetId}' \
  --output table
```

기대 결과:

- `internet-facing` Load Balancer는 Public Subnet을 사용한다.
- `internal` Load Balancer는 Private Subnet을 사용한다.
- Worker node subnet과 internet-facing ALB subnet이 섞이지 않는다.

## Risk 및 미적용 시 영향

- **공격 시나리오:** Worker node가 Public Subnet에 있고 Public IP를 보유한 상태에서 Security Group 오구성으로 SSH, kubelet 관련 포트, NodePort, 애플리케이션 포트가 인터넷에 노출된다. 공격자는 노드를 직접 스캔하고 취약한 데몬 또는 잘못 열린 포트를 통해 침투를 시도할 수 있다.
- **Pod 영향:** AWS VPC CNI 환경에서는 Pod가 VPC subnet에서 IP를 할당받는다. node group이 Public Subnet에 있으면 Pod 네트워크도 public subnet 설계의 영향을 받기 쉽고, Ingress 또는 Security Group 오구성이 곧바로 workload 노출로 이어질 수 있다.
- **운영 영향:** Public Subnet에 node를 두면 어떤 리소스가 외부 진입점인지 구분하기 어려워진다. ALB, bastion, NAT 계층만 Public Subnet에 둔 구조보다 사고 분석과 접근 제어가 복잡해진다.
- **영향 범위:** Worker node 침해, Pod lateral movement, 민감 데이터 접근, 클러스터 내부 서비스 스캔, 서비스 장애
- **심각도:** **높음**

## 인적 리소스 및 비용

- AWS 추가 비용: 기존 `fck-nat` instance 비용 발생. NAT Gateway 추가 비용은 없음
- 비용 참고: NAT Gateway 대신 `fck-nat`을 사용하므로 시간당 NAT Gateway 비용과 처리량 비용을 줄일 수 있지만, EC2 instance 운영과 가용성 관리는 직접 고려해야 한다
- 운영 주의사항: node group subnet 변경으로 node 교체가 발생할 수 있어 workload disruption을 확인해야 한다

## 참고 자료

- [Amazon EKS VPC and subnet considerations](https://docs.aws.amazon.com/eks/latest/best-practices/subnets.html)
- [Deploy private clusters with limited internet access](https://docs.aws.amazon.com/eks/latest/userguide/private-clusters.html)
- [AWS Load Balancer Controller - Subnet Discovery](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/subnet_discovery/)
- [fck-nat](https://fck-nat.dev/)

## Assessment 체크리스트

- [ ] VPC가 최소 2개 AZ에 Public Subnet과 Private Subnet 쌍을 가지고 있는가?
- [ ] managed node group의 subnet ID가 Private Subnet ID와 일치하는가?
- [ ] Worker node EC2 instance에 Public IP가 없는가?
- [ ] EKS control plane 연결 subnet이 Private Subnet 중심으로 구성되어 있는가?
- [ ] Public Subnet route table의 default route가 Internet Gateway를 향하는가?
- [ ] Private Subnet route table의 default route가 `fck-nat` primary ENI를 향하는가?
- [ ] Public Subnet에는 `kubernetes.io/role/elb=1` tag가 있는가?
- [ ] Private Subnet에는 `kubernetes.io/role/internal-elb=1` tag가 있는가?
- [ ] internet-facing Load Balancer는 Public Subnet에, internal Load Balancer는 Private Subnet에 생성되는가?
- [ ] `terraform test`로 infra, VPC, EKS 모듈의 subnet 배치 검증이 통과하는가?

