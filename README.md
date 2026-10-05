# Quantumult X 远程重写与脚本

供自己长期维护的 QX 订阅仓库。只存公开脚本和配置，不存 Cookie、Token、账号标识或抓包。

## 小黑盒：当前是只读验证版，不是自动签到

2026-10-04 已在 Node 环境实际验证：本地新 Web 签名可以查询当前账号及任务列表；get_sign_state 仍返回非法的请求。未在 iPhone QX 实机验证。默认脚本不发起 sign，不领取奖励。

## 安装

1. 在 QX 重写资源中添加下面订阅地址并开启：

```text
https://raw.githubusercontent.com/nexdoul/quantumult-x-rewrites/main/rewrites/heybox.rewrite
```

2. 开启 Rewrite 与 MitM，安装并信任自己的 QX CA。订阅包含 api.xiaoheihe.cn 的 hostname。不要覆盖现有域名列表。
3. 在小黑盒登录后打开个人资料/账号页，等待有效的 account/info 请求被动采集。本地凭据只保存在 QX $prefs；不必重新签到。
4. 将以下任务加入现有 [task_local]，先手动运行验证：

```ini
15 9 * * * https://raw.githubusercontent.com/nexdoul/quantumult-x-rewrites/main/scripts/heybox.js, tag=小黑盒-Web只读验证-不签到, enabled=false
```

如果禁用状态无法手动执行，可临时启用后运行。成功通知为“Web 只读验证通过”，不等于签到到账。手动验证后若希望每天只读检查，可改 enabled=true；每天设备当地时间 09:15 执行，仍不会签到。

配置片段：[configs/heybox.snippet.conf](configs/heybox.snippet.conf)。

## 文件

- scripts/heybox.js：本地采集、纯 JS Web 签名、默认只读任务。
- rewrites/heybox.rewrite：远程重写订阅，引用官方 GitHub Raw 脚本地址。
- configs/heybox.snippet.conf：可合并配置片段。

## 安全与边界

- 只对官方 API 发送本地凭据；无远程签名服务。
- 脚本默认仅请求 account/info 与 task/list_v2，核对返回账号。
- 未触发真实签到；不要把 HTTP 200 或任务列表成功当作签到成功。
- 原 native 签到开发框架保留，但 nativeHkey 未实现，默认入口不调用。
- .env.example 只提供维护者本地变量名称。复制为 .env 后自行填写，绝不可提交。
- 原始抓包包含登录凭据，禁止上传。

未来新增规则可放入 rewrites/，对应脚本放入 scripts/，每项单独说明实际验证情况。
