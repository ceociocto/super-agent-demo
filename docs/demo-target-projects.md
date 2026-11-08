# 面向非技术观众的演示目标项目

两个项目均为专门制作的原创演示项目，不依赖第三方框架、账号或后端业务。预设缺陷真实存在于代码中，明确标注为演示基线；Super Agent 需要实际修改和测试，没有针对这两个仓库的专用执行分支。

| 项目 | 观众看得见的问题 | 修复后变化 | 运行 |
| --- | --- | --- | --- |
| [咖啡店购物车](https://github.com/ceociocto/superagent-demo-shop) | 两杯同样的咖啡，只收了一杯包装费 | 包装费从2元变为4元 | `npm start`，127.0.0.1:4321 |
| [出行清单](https://github.com/ceociocto/superagent-demo-checklist) | 已勾选的行李刷新后变回未准备 | 刷新后勾选和进度保留 | `npm start`，127.0.0.1:4322 |

两个仓库均有可重复检出的 `demo-baseline-v1` 标签。当前账号对两个仓库均已验证具有写权限。

本机已准备：

```sh
# 咖啡店，端口4321
cd /Volumes/sn7100/code/superagent-demo-shop
npm start

# 另一个终端：出行清单，端口4322
cd /Volumes/sn7100/code/superagent-demo-checklist
npm start
```

在其他演示机器上先分别 `git clone` 对应仓库，然后进入目录启动即可。

需要Node.js 22或以上；无需npm install。`npm test`检查基线功能；`npm run test:issue`是待修问题的真实复现测试，演示基线预期失败，修复后必须通过。不能把预期失败说成整个项目正常通过。

## 一次交办两个目标

```text
请创建两个独立任务，分别处理：
1. https://github.com/ceociocto/superagent-demo-shop/issues/1
2. https://github.com/ceociocto/superagent-demo-checklist/issues/1

先分别阅读问题与项目README，运行npm test和npm run test:issue，记录修复前结果。实际修改代码并补充回归，最终两项测试都应通过。每个项目使用自己的工作副本与分支，在对应仓库创建关联issue的草稿PR，不合并。交付面向普通用户的修复前后说明、真实测试结果和PR链接。不要改低测试期望或移除复现测试。
```

运行中追加：

```text
给刚才的咖啡店修复原任务补充 https://github.com/ceociocto/superagent-demo-shop/issues/2 ：商品小计满50元免配送费，门槛不含包装费。继续原Task，更新同一个分支和草稿PR，不重复创建PR。
```

或者：

```text
给刚才的出行清单修复原任务补充 https://github.com/ceociocto/superagent-demo-checklist/issues/2 ：增加“只看未准备”开关，筛选不能丢数据，总进度仍按全部条目计算。继续原Task，更新同一个分支和草稿PR。
```

## 讲给听众听

- 购物车：原来买两杯只收一个杯子的包装费；现在按实际杯数算，金额与测试都可以核对。
- 清单：原来勾选后刷新就丢；现在刷新后仍然保留，准备进度也一致。
- 两个任务交给不同Worker，互不覆盖；补充要求回到原任务，最终各自交付真实PR。

## 重复演示

两个仓库的main保留待修基线。演示PR保持草稿、不合并，避免下次已经没有缺陷。重新演示可要求新建有时间标识的分支，但先查已有PR，明确是续办还是新一轮。不要通过删除旧PR、强推或重写历史“重置”。

本机预览从各仓库目录启动；Agent修改的是任务工作副本。展示修复后页面时，需在其实际工作副本另选本机端口启动，或另行检出PR到专用预览目录；初始预览不会自动跟随PR修改。

其他长日志、停止恢复和MCP接力场景仍使用[具体演示任务清单](demo-catalog-v3.md)。旧清单的第三方公开issue保留为进阶备选，主线优先使用这里的自有仓库。

## 本次创建与验证

- 咖啡店基线：`63df8eb`；8项基础测试通过；包装费复现测试按预期失败（200分，期望400分）。
- 清单基线：`f562526`；7项基础测试通过；刷新持久化复现测试按预期失败（false，期望true）。
- 两个项目语法检查通过；浏览器分别确认费用错误及勾选后刷新状态丢失。
- 两个仓库均为原创MIT项目，README含页面截图；四张issue都已创建并核查为OPEN。
- 这里只准备了待修目标，没有提前修复或替Super Agent创建修复PR。
