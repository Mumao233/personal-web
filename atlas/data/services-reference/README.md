# 参考图层数据

这些是具有明确版本的科学与地理参考资料，不是实时观测。来源、下载地址、加工方法、版本和校验值见 `manifest.json`。

- **板块边界**：PB2002，Peter Bird（2003），doi:10.1029/2001GC000252。Hugo Ahlenius / Nordpil 的公开 GeoJSON 转换，ODC-By-1.0。保留原始坐标。
- **俯冲带与洋中脊**：从 PB2002 原始逐段分类提取 `SUB`（俯冲边界）和 `OSR`（洋中脊），仅合并源文件已声明连续且类别相同的线段。不是所有海沟的水深中心线，也不包含全部海底山脊。黄色表示洋中脊，粉红色表示俯冲边界。
- **专属经济区／海洋边界**：Flanders Marine Institute (VLIZ), Marine Regions，World Maritime Boundaries v12（2023），CC BY 4.0。保存公开 WMS 返回的 4096×2048 透明地图及官方图例，保留原有争议边界、共同管理区等线型。仅适用于科学、教育与研究参考，不具有法律或航海效力。放大后受栅格分辨率限制。

Marine Regions 最新数据与服务：[来源页面](https://www.marineregions.org/sources.php#marbound)；[许可与使用条件](https://www.marineregions.org/disclaimer.php)。请到原站获取完整数据库；本项目仅附带 WMS 参考渲染图。

PB2002 原始转换仓库：[fraxen/tectonicplates](https://github.com/fraxen/tectonicplates)，[ODC Attribution 1.0](https://opendatacommons.org/licenses/by/1.0/)。
