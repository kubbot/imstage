/** IDs for non-message selections; existing message IDs take precedence. */
export function resolveTarget(scene, id) {
  if (typeof id !== "string" || !id) return null;
  if (scene.reference?.plan.edits.some(p => `@patch:${p.id}` === id)) return {kind:'patch',id:id.slice(7)};
  if (scene.messages.some(m => m.id === id)) return { kind: 'message', id };
  if (id === '@scene') return { kind: 'scene', id };
  if (id.startsWith('@participant:') && scene.participants.some(p => p.id === id.slice(13))) return { kind: 'participant', id: id.slice(13) };
  return null;
}
