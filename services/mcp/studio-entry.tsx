import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SceneView from '../../apps/web/src/studio/SceneView';
import type { Scene } from '../../apps/web/src/studio/model';

// React's static renderer escapes scene text and emits no hydration scripts.
// https://react.dev/reference/react-dom/server/renderToStaticMarkup
export function renderStudioMarkup(scene: Scene) {
  return renderToStaticMarkup(createElement(SceneView, { scene, exportMode: true }));
}
