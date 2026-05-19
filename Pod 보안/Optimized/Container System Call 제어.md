# Container System Call 제어

> **Phase:** Optimized
>
> **보안 영역:** Pod 보안
>
> **담당:** 장해윤
>
> **난이도:** ★★★

---

## 왜 필요한가

Linux 커널은 300개 이상의 시스템 콜(syscall)을 제공한다. `RuntimeDefault` seccomp 프로파일은 이 중 위험도가 높은 일부만 차단하지만, 실제 서비스가 사용하지 않는 수백 개의 syscall을 여전히 허용한다.

공격자가 컨테이너 취약점을 통해 코드 실행 권한을 얻었을 때, 허용된 syscall의 범위가 넓을수록 공격 옵션이 많아진다. 예를 들어 `ptrace`는 다른 프로세스를 디버깅하거나 메모리를 읽는 데 사용되고, `mount`는 호스트 파일시스템에 접근하는 데 악용될 수 있다.

커스텀 Seccomp 프로파일은 각 컨테이너가 실제로 사용하는 syscall만 허용하고 나머지를 전부 차단한다. 이 원칙을 **최소 syscall 허용**이라고 한다.

이 단계에서는 외부 Operator 없이 Kubernetes 네이티브 방식으로 구현한다.

- **ConfigMap:** 서비스별(web, api, db) seccomp 프로파일 JSON을 저장한다.
- **DaemonSet:** 모든 노드의 `/var/lib/kubelet/seccomp/` 경로에 프로파일을 복사한다.
- **Pod spec:** `seccompProfile.type: Localhost`로 해당 프로파일을 참조한다.

ConfigMap이 변경되면 DaemonSet이 재배포되어 노드의 프로파일이 자동 갱신된다.

---

## 수행 방법

**사전 조건**

- EKS 클러스터 노드에 `kubectl debug` 또는 SSH 접근이 가능해야 프로파일 복사 결과를 확인할 수 있다.
- 각 서비스(web/nginx, api/echo-server, db/redis)의 실제 사용 syscall을 `SCMP_ACT_LOG`로 먼저 수집해야 한다. 누락된 syscall은 `SCMP_ACT_ERRNO`로 차단되어 CrashLoopBackOff를 유발한다.
- EKS 노드 아키텍처를 확인해야 한다. Graviton(ARM/aarch64) 노드를 사용하는 경우 프로파일에 `SCMP_ARCH_AARCH64`를 반드시 포함해야 한다.

### Step 1: 현황을 파악한다

현재 워크로드의 seccomp 설정을 확인한다.

```bash
kubectl get pods -n team-a -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.securityContext.seccompProfile}{"\n"}{end}'
```

기대 결과(미적용 시): `seccompProfile`이 `RuntimeDefault`이거나 비어 있다.

노드 아키텍처를 확인한다.

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.nodeInfo.architecture}{"\n"}{end}'
```

Graviton 노드(aarch64)가 있으면 seccomp 프로파일에 `SCMP_ARCH_AARCH64`를 추가해야 한다.

### Step 2: 사용 syscall을 먼저 수집한다 (사전 단계)

프로파일을 바로 `SCMP_ACT_ERRNO`(차단)으로 배포하면 누락된 syscall로 인해 Pod가 크래시된다. `SCMP_ACT_LOG`로 먼저 배포해 audit 로그에서 실제 사용 syscall을 확인한다.

```bash
# 노드에서 audit 로그 확인 (seccomp log 모드에서 수집)
# EKS 노드에 SSM Session Manager로 접근하거나 kubectl debug 사용
kubectl debug node/<NODE_NAME> -it --image=ubuntu -- bash
cat /var/log/kern.log | grep "auid=" | grep type=SECCOMP
```

### Step 3: ConfigMap과 DaemonSet을 배포한다

`modules/k8s-base/main.tf`에 ConfigMap과 DaemonSet을 추가한다.

```hcl
resource "kubernetes_config_map" "seccomp_profiles" {
  metadata {
    name      = "seccomp-profiles"
    namespace = "kube-system"
  }

  data = {
    "web-nginx.json" = jsonencode({
      defaultAction = "SCMP_ACT_ERRNO"
      architectures = ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"]
      syscalls = [{
        names = [
          "accept4", "access", "arch_prctl", "bind", "brk", "capget", "capset",
          "chdir", "clone", "close", "connect", "dup", "dup2", "dup3",
          "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_wait", "eventfd2",
          "execve", "exit", "exit_group", "faccessat", "fcntl", "fstat",
          "fstatfs", "futex", "getcwd", "getdents64", "getegid", "geteuid",
          "getgid", "getpid", "getppid", "getrlimit", "getsockname",
          "getsockopt", "getuid", "ioctl", "lseek", "listen", "lstat",
          "madvise", "mmap", "mprotect", "munmap", "nanosleep", "newfstatat",
          "openat", "pipe", "pipe2", "prctl", "pread64", "prlimit64",
          "pwrite64", "read", "readv", "recvfrom", "recvmsg", "rt_sigaction",
          "rt_sigprocmask", "rt_sigreturn", "sendfile", "sendmsg", "sendto",
          "setgid", "setgroups", "setuid", "setsockopt", "sigaltstack",
          "socket", "socketpair", "stat", "statfs", "sysinfo", "tgkill",
          "uname", "wait4", "write", "writev"
        ]
        action = "SCMP_ACT_ALLOW"
      }]
    })

    "api-echo-server.json" = jsonencode({
      defaultAction = "SCMP_ACT_ERRNO"
      architectures = ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"]
      syscalls = [{
        names = [
          # nginx 기본 syscall 포함 + api 서버 추가 syscall
          "accept4", "arch_prctl", "bind", "brk", "capget", "capset", "chdir",
          "clone", "close", "connect", "dup", "dup2", "epoll_create1",
          "epoll_ctl", "epoll_pwait", "epoll_wait", "execve", "exit",
          "exit_group", "faccessat", "fcntl", "fstat", "futex", "getcwd",
          "getdents64", "getegid", "geteuid", "getgid", "getpid", "getppid",
          "getrlimit", "getsockname", "getsockopt", "getuid", "ioctl", "kill",
          "lseek", "listen", "madvise", "memfd_create", "mmap", "mprotect",
          "munmap", "nanosleep", "newfstatat", "openat", "pipe", "pipe2",
          "poll", "prctl", "pread64", "prlimit64", "read", "readlink",
          "readv", "recvfrom", "recvmsg", "rt_sigaction", "rt_sigprocmask",
          "rt_sigreturn", "rt_sigtimedwait", "sched_getaffinity",
          "sched_yield", "sendmsg", "sendto", "setgid", "setgroups", "setuid",
          "setsockopt", "sigaltstack", "socket", "socketpair", "stat",
          "statfs", "statx", "sysinfo", "tgkill", "uname", "unlink",
          "wait4", "write", "writev"
        ]
        action = "SCMP_ACT_ALLOW"
      }]
    })

    "db-redis.json" = jsonencode({
      defaultAction = "SCMP_ACT_ERRNO"
      architectures = ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"]
      syscalls = [{
        names = [
          # redis 필요 syscall (네트워크 + 파일 I/O 중심)
          "accept", "accept4", "arch_prctl", "bind", "brk", "capget", "capset",
          "chdir", "clone", "close", "connect", "dup", "dup2", "epoll_create",
          "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_wait", "execve",
          "exit", "exit_group", "faccessat", "fcntl", "fdatasync", "fstat",
          "fsync", "ftruncate", "futex", "getcwd", "getdents64", "getegid",
          "geteuid", "getgid", "getpid", "getppid", "getrlimit", "getsockname",
          "getsockopt", "getuid", "ioctl", "lseek", "listen", "madvise",
          "mmap", "mprotect", "munmap", "nanosleep", "newfstatat", "openat",
          "pipe", "pipe2", "prctl", "pread64", "prlimit64", "pwrite64",
          "read", "readv", "recvfrom", "recvmsg", "rename", "rt_sigaction",
          "rt_sigprocmask", "rt_sigreturn", "select", "sendmsg", "sendto",
          "setgid", "setgroups", "setuid", "setsockopt", "sigaltstack",
          "socket", "socketpair", "stat", "statfs", "sysinfo", "tgkill",
          "uname", "wait4", "write", "writev"
        ]
        action = "SCMP_ACT_ALLOW"
      }]
    })
  }
}

resource "kubernetes_daemonset" "seccomp_installer" {
  metadata {
    name      = "seccomp-installer"
    namespace = "kube-system"
  }

  spec {
    selector {
      match_labels = { app = "seccomp-installer" }
    }

    template {
      metadata {
        labels = { app = "seccomp-installer" }
      }

      spec {
        init_container {
          name    = "install-profiles"
          image   = "busybox:1.36"
          command = ["sh", "-c", "cp /profiles/* /host-seccomp/"]

          volume_mount {
            name       = "profiles"
            mount_path = "/profiles"
          }

          volume_mount {
            name       = "host-seccomp"
            mount_path = "/host-seccomp"
          }
        }

        container {
          name    = "pause"
          image   = "gcr.io/google-containers/pause:3.9"
        }

        volume {
          name = "profiles"
          config_map { name = kubernetes_config_map.seccomp_profiles.metadata[0].name }
        }

        volume {
          name = "host-seccomp"
          host_path { path = "/var/lib/kubelet/seccomp" }
        }

        toleration {
          operator = "Exists"
        }
      }
    }
  }

  depends_on = [kubernetes_config_map.seccomp_profiles]
}
```

### Step 4: 워크로드에 Localhost 프로파일을 적용한다

`manifests/base/web/deployment.yaml`, `manifests/base/api/deployment.yaml`, `manifests/base/db/statefulset.yaml`에서 seccompProfile을 변경한다.

```yaml
# 변경 전
securityContext:
  seccompProfile:
    type: RuntimeDefault

# 변경 후 (web 예시)
securityContext:
  seccompProfile:
    type: Localhost
    localhostProfile: web-nginx.json
```

각 서비스의 `localhostProfile` 값:
- web: `web-nginx.json`
- api: `api-echo-server.json`
- db: `db-redis.json`

---

## 검증 방법

DaemonSet이 모든 노드에 배포되었는지 확인한다.

```bash
kubectl get daemonset seccomp-installer -n kube-system
kubectl get pods -n kube-system -l app=seccomp-installer -o wide
```

기대 결과: DESIRED와 READY 수가 노드 수와 동일하다.

노드에 프로파일이 복사되었는지 확인한다.

```bash
# kubectl debug으로 노드 접근
kubectl debug node/<NODE_NAME> -it --image=ubuntu -- ls /host/var/lib/kubelet/seccomp/
```

기대 결과: `web-nginx.json`, `api-echo-server.json`, `db-redis.json` 3개 파일이 존재한다.

Pod가 Localhost seccomp 프로파일로 동작하는지 확인한다.

```bash
kubectl get pod -n team-a -l app=web -o jsonpath='{.items[0].spec.securityContext.seccompProfile}'
```

기대 결과: `{"localhostProfile":"web-nginx.json","type":"Localhost"}`

차단 동작을 테스트한다. 프로파일에 포함되지 않은 syscall은 `EPERM` 또는 `EACCES` 오류로 차단된다.

```bash
# 컨테이너 내에서 허용되지 않은 syscall 시도 (예: ptrace)
kubectl exec -it <web-pod> -n team-a -- python3 -c "import ctypes; ctypes.CDLL(None).ptrace(0,0,0,0)"
```

기대 결과: `Operation not permitted` 오류가 반환된다.

**검증 완료 기준**

- DaemonSet DESIRED = READY = 전체 노드 수.
- 각 노드 `/var/lib/kubelet/seccomp/`에 3개 프로파일 파일이 존재한다.
- web, api, db Pod의 `seccompProfile.type`이 `Localhost`로 설정되어 있다.
- 허용되지 않은 syscall 호출 시 `Operation not permitted` 오류가 반환된다.

---

## Risk 및 미적용 시 영향

- **공격 표면 확대:** `RuntimeDefault`는 약 300개 이상의 syscall을 허용한다. 공격자가 RCE 취약점을 통해 컨테이너에 진입했을 때 사용 가능한 공격 옵션이 넓어진다. 커스텀 프로파일은 실제 필요한 syscall만 허용해 공격 옵션을 최소화한다.
- **CrashLoopBackOff 리스크:** 프로파일에 필요한 syscall이 누락되면 Pod가 시작되지 않는다. 반드시 `SCMP_ACT_LOG` 모드로 사용 syscall을 먼저 파악한 뒤 `SCMP_ACT_ERRNO`로 전환해야 한다.
- **아키텍처 불일치:** Graviton(aarch64) 노드에 x86_64 전용 프로파일을 적용하면 CrashLoopBackOff가 발생한다. 프로파일에 `SCMP_ARCH_AARCH64`를 반드시 포함해야 한다.
- **프로파일 관리 부담:** 서비스 코드가 변경되어 새 syscall이 필요해지면 프로파일도 함께 업데이트해야 한다. ConfigMap 기반 관리로 변경 이력을 Git에 추적한다.
- **심각도:** **중간**. 커스텀 Seccomp 없이도 서비스는 동작하지만, 컨테이너 탈출 후 공격자의 행동 범위가 넓어진다.

---

## 인적 리소스 및 비용

| 항목 | 내용 |
| --- | --- |
| 담당자 | 장해윤 |
| AWS 추가 비용 | 없음 (Kubernetes 네이티브 기능) |
| 도구 비용 | 없음 |
| 운영 고려사항 | 신규 서비스 추가 시 해당 서비스의 syscall 프로파일을 사전에 수집하고 ConfigMap에 추가해야 한다. 정기적으로 `SCMP_ACT_LOG` 모드로 운영해 프로파일 누락 여부를 점검한다. |

---

## Assessment 체크리스트

- [ ] `seccomp-installer` DaemonSet이 모든 노드에서 `Running` 상태인가?
- [ ] 각 노드 `/var/lib/kubelet/seccomp/`에 3개 프로파일 파일이 존재하는가?
- [ ] web, api, db Pod의 `seccompProfile.type`이 `Localhost`로 설정되어 있는가?
- [ ] 프로파일이 `SCMP_ARCH_AARCH64`를 포함해 Graviton 노드를 지원하는가?
- [ ] 허용되지 않은 syscall 호출 시 `Operation not permitted` 오류가 반환되는가?
- [ ] 기존 워크로드가 프로파일 적용 후 정상 동작하는가?

---

## 참고 자료

- [Kubernetes - Restrict a Container's Syscalls with seccomp](https://kubernetes.io/docs/tutorials/security/seccomp/)
- [Linux - seccomp(2) man page](https://man7.org/linux/man-pages/man2/seccomp.2.html)
- [OCI Runtime Spec - seccomp](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md#seccomp)
- [CIS Kubernetes Benchmark v1.12.0](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guidance](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
- [AWS EKS Best Practices - Pod Security](https://docs.aws.amazon.com/eks/latest/best-practices/pod-security.html)

---

## 연계된 보안 가이드라인 항목

- **CIS Kubernetes Benchmark v1.12.0**
  컨테이너에 seccomp 프로파일을 적용해 허용되지 않은 syscall을 차단하고 커널 공격 표면을 최소화하도록 권고한다. `RuntimeDefault` 대신 커스텀 프로파일 사용을 권장한다.
- **NSA/CISA Kubernetes Hardening Guidance**
  컨테이너가 필요로 하지 않는 Linux 기능과 시스템 콜을 제거해 공격 표면을 줄이도록 요구한다. 최소 syscall 허용 원칙은 이 지침의 핵심 요건이다.
- **AWS EKS Best Practices**
  EKS 워크로드에 커스텀 Seccomp 프로파일을 적용해 런타임에서 허용되는 syscall 범위를 제한하도록 권장한다.
