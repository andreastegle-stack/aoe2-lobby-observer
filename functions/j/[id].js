// Shareable join link: /j/<lobby id> opens the game in that lobby.
export function onRequestGet({ params }) {
  if (!/^\d+$/.test(params.id)) return new Response('Not found', { status: 404 });
  return new Response(null, { status: 302, headers: { Location: `aoe2de://0/${params.id}` } });
}
