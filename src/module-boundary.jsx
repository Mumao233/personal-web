import React from "react";

export default class ModuleBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className={this.props.quiet ? "module-recovery module-recovery-quiet" : "module-recovery"} role="alert">
        <p>{this.props.label || "这个模块"}暂时无法加载。</p>
        <p className="fine">可以继续使用其他栏目，或刷新页面重试。编辑中的内容请先保存。</p>
        <button type="button" className="quiet" onClick={() => window.location.reload()}>刷新页面重试</button>{" "}
        <a href="/">返回主页</a>
      </section>
    );
  }
}
