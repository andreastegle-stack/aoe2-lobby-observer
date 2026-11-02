// Shareable spectate link: /w/<lobby id> opens the game watching that match.
export function onRequestGet({ params }) {
  if (!/^\d+$/.test(params.id)) return new Response('Not found', { status: 404 });
  return new Response(null, { status: 302, headers: { Location: `aoe2de://1/${params.id}` } });
}
