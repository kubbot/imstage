import { Component, type ReactNode } from 'react';
import type { Locale } from './marketing/locale';

/** A failed route chunk should leave navigation and a deliberate retry usable. */
export default class RouteBoundary extends Component<{ children: ReactNode; locale: Locale }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    const zh = this.props.locale === 'zh';
    return <section className="route-error" role="alert">
      <h1>{zh ? '暂时无法加载此页面' : 'This page could not load'}</h1>
      <p>{zh ? '重新加载页面，获取当前版本。你也可以先返回首页。' : 'Reload to fetch the current version, or return to the homepage.'}</p>
      <div><button className="btn btn-primary" onClick={() => location.reload()}>{zh ? '重新加载' : 'Reload page'}</button><a className="btn btn-secondary" href="#/">{zh ? '返回首页' : 'Back to home'}</a></div>
    </section>;
  }
}
