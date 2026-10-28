# 阶段 A 调研：游戏原生 Live2D 交互配置

调研时间：2026-10-28。范围内只查数据、未改代码。

## 结论

**数据存在，而且是网格级的**，能覆盖 240 个皮肤里的 133 个（约 56%）。但它描述的是「哪个网格响应触摸、驱动哪个参数」，**不是「点这里播哪个动作」**——动作映射需要靠命名规则推导或退回手配。

## 数据源

- 仓库：[AzurLaneTools/AzurLaneLuaScripts](https://github.com/AzurLaneTools/AzurLaneLuaScripts)，从游戏包里抽出的 Lua 脚本，自动更新
- 文件：`CN/sharecfg/ship_l2d.lua`（3.86 MB，223,244 行）
- 另有 `EN/`、`JP/`、`KR/`、`TW/` 同名文件，结构一致

## 结构

文件里有两种组织方式，关键是后者：

```lua
pg.ship_l2d.all = { 101, 102, ... }        -- 记录 id 清单
pg.base.ship_l2d = {}
pg.base.ship_l2d[101] = {
    draw_able_name = "ArtMesh298",   -- 响应的网格名
    ship_skin_id  = 205015,          -- 皮肤 ID（不是 prefab）
    parameter     = "ParamELLegR2Z", -- 触摸时驱动的参数
    react_pos_x = 0, react_pos_y = 0,-- 触点位置（参数值，非屏幕坐标）
    react_condition = "",            -- 触发条件
    drag_direct = 0,                 -- 拖动方向
    range = { -2, 3 },               -- 参数取值范围
    range_abs = 0,
    revert = 200, revert_smooth = 200, -- 松手回弹（毫秒）
    offset_x = 0, offset_y = 50, offset_circle = "",
    mode = 2, smooth = 200, limit_time = 0,
    save_parameter = 0, start_value = 0,
    ignore_react = 1, ignore_action = 0,
    gyro = 0, gyro_x/y/z = 0,
    action_trigger = "", action_trigger_active = "",   -- 全表为空
    listener_data = "", parts_data = "", relation_parameter = "",
    revert_action_index = 0, revert_idle_index = "",
    shop_action = 0,
}
```

共 **3900 条**这类记录。

## 覆盖率

| 项 | 数值 |
|---|---|
| 记录总数 | 3900 |
| 含 `Touch*` 网格的记录 | 3633 |
| 不同 `ship_skin_id` | 135 |
| 有触摸网格的皮肤 | 133 / 240（56%） |
| 单皮肤触摸网格数 | 1 ~ 95 个（多的近一百个） |

## 关键发现：网格名直接对应动作组

触摸网格的命名和我们的动作组是同一套：

- `TouchDrag`、`TouchDrag1` … `TouchDrag8`
- `TouchIdle`、`TouchIdle1` … `TouchIdle12`

记录的 `parameter` 字段是网格名的**下划线小写形式**：

```
TouchDrag1  ->  touch_drag1
TouchDrag2  ->  touch_drag2
TouchIdle3  ->  touch_idle3
```

而皮肤目录里的动作组正是 `touch_drag1.motion3.json`、`touch_idle3.motion3.json`。

**即：拿到网格名就能推出动作组，不需要任何人工映射。** 这是零配置方案的基础。

## 限制（必须说清楚）

1. **没有显式的动作触发字段**。`action_trigger` 与 `action_trigger_active` 在全部 3900 条里都是空字符串。也就是说数据只告诉我们「这个网格驱动这个参数」，动作得靠上面的命名规则推；推不出来的（比如 `ArtMesh298 → ParamELLegR2Z` 这种）只能手配。
2. **`ship_skin_id` 不是 prefab 名**。它是 205015 这类数字，要 join 游戏表 `ship_skin_template`（id → prefab）才能对应到 `lafei_4` 这样的目录名。这张表在同一个仓库的 `sharecfg/ship_skin_template.lua`（已确认存在，210 KB），但**本次没能下载下来逐条验证 `prefab` 字段**（网络问题，raw.githubusercontent.com 连续失败）。接入前必须先验证这一点，否则映射链路不通。
3. **`react_pos_x/y` 不是屏幕坐标**，是参数取值。真正的点击区域是**网格本体**，需要从模型的 mesh 几何去判（正好是阶段 B 的做法）。
4. **只覆盖 56%**。剩下 44% 的皮肤在表里没有触摸网格记录，只能手配或沿用现在的三段兜底。
5. 数据来自第三方解包仓库，随游戏版本变化，需要版本化缓存，不能写死在本仓库。

## 对阶段 B 的意义

- **区域来源**：有原生数据的皮肤，可以自动生成 v2 的 `zones`（`meshes: ["TouchDrag1"]`），动作按命名规则填 `drag: "touch_drag1"`，做到零配置。
- **动作映射**：只有 `Touch*` 命名的能自动推；其余网格（`ArtMesh*`）需要手配或忽略。
- **仍需手动标定的场景**：44% 无数据皮肤、需要合并多块网格成同一区的、以及「切换待机到 idleN」这种状态区。
- **接入前提**：需要额外拉 `ship_skin_template.lua` 做 id → prefab 映射，并做一次本地缓存（约 4 MB）。

## 建议

值得接入，但**作为「一键导入」而不是自动生效**：
1. 保留阶段 B 的手动标定作为兜底
2. 增加「从游戏数据导入触摸区」按钮：拉两张表 → 按 prefab 匹配 → 生成 v2 zones → 用户确认后写入 `hitareas/<skin>.json`
3. 导入结果要可见可编辑，别静默覆盖用户手配的数据
