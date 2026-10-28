# B0 报告：运行时核实 Touch 网格

调研时间：2026-10-28。只加调试代码（`PET_TOUCH_DEBUG=1/2`），未改任何行为。
测试皮肤：`benningdun_2`（交互最复杂的一类）。

## 1. Touch 名字出现在哪个列表

| 列表 | 总数 | 带 Touch 的项 | 说明 |
|---|---|---|---|
| drawable（网格） | 1663 | **72** | `TouchHead`、`TouchBody`、`TouchSpecial`、`TouchIdle1..N`、`TouchDrag1..N` |
| parameter（参数） | 537 | 73 | 但都是 `ctouch_drag10`、`atouch_drag16`、`touch_idle8` 这类**参数名**，带前缀 |
| part（部件） | 347 | **0** | 无 |

**结论：Touch 名字确实是 drawable（网格）。** 参数里同名的是驱动用的参数，不是区域。

## 2. 每个 Touch 网格的属性

全部是 **4 顶点四边形**（`verts = 4`），即简单矩形。抽样：

```
TouchHead      opacity=1.000  order=1577
TouchBody      opacity=1.000  order=1578
TouchSpecial   opacity=1.000  order=1579
TouchIdle1     opacity=1.000  order=1580
TouchIdle2     opacity=0.000  order=1581
TouchIdle3     opacity=0.000  order=1582
TouchIdle8     opacity=1.000  order=1587
TouchIdle10    opacity=0.000  order=1589
TouchDrag1..4  opacity=0.000  order=1630..1633
```

**opacity 有 0 和 1 两种，不是全 0**。说明它们是游戏里的碰撞网格，默认按状态显示/隐藏，但**不能沿用「可见才可点」的过滤规则**（否则 TouchDrag 全部失效）。

## 3. 切换状态后 opacity 有没有变化

把模型切到 `touch_idle3` 动作，前后各扫一次：

```
切换前：TouchIdle1 opacity=1.000   TouchIdle3 opacity=0.000
切换后：TouchIdle1 opacity=1.000   TouchIdle3 opacity=0.000
```

**没有变化**。顶点数也没变（始终 4）。

**结论：opacity 不反映当前动作状态**，不能用来决定「哪些区此刻可点」。按你的预案，B1 先**全部开放**，不用状态过滤。

可能的解释：opacity 由参数控制（比如 `ParamTouchIdle3`），播动作不会改参数值；游戏里是在特定剧情/交互流程中才把对应参数拉起来。要精确复现状态切换，得先搞清楚是哪个参数，这属于以后「真实驱动参数」那一档，不在 B1 范围。

## 4. 描边（未完成）

描边代码已写（`dumpTouchMeshes` 里用 `PIXI.Graphics` 画顶点轮廓，按 head/body/special/idle/drag 分色），但**画面上看不到**，原因是坐标系不对：

```
顶点样本 TouchSpecial: -6, 1, -13, 1, -6, -5, -13, -5
model.scale = 0.0400
```

顶点值是 `-13 ~ 1` 这种小数量级，不是画布像素坐标（画布是 5000×5000，顶点应该在 ±2500）。直接乘 0.04 后只有不到 1 像素，所以看不见。

**这一项没做完，需要先确认顶点所在的坐标空间**：可能是归一化空间、也可能是 drawable 的局部空间，需要配合 `internalModel` 的变换矩阵换算。这一步对 B1 很关键——判命中用的也是这套顶点，坐标空间搞错就会点不准。

## 对 B1 的影响

- **区域来源可行**：72 个网格、4 顶点矩形，几何数据拿得到。
- **状态过滤不可行**：opacity 不随动作变，B1 先全部开放。
- **必须先解决坐标换算**：顶点是归一化值，判命中要把光标坐标转进同一个空间（或把顶点转出来），这是 B1 的第一个技术点。
- **优先级顺序**按你给的来：Drag/Idle > Special > Head > Body。

## 建议

进 B1 之前，我先花一点时间把顶点坐标空间确认清楚（对比 `getBounds()` 和顶点换算后的包围盒是否吻合），确认后再写命中判定。如果坐标空间确认不了，自动识别这条路就要退回手动标定。
