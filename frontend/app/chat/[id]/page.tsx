import { ChatView } from "./chat-view";

// The static export prerenders a single placeholder; the backend serves it for every
// /chat/<id> and the view reads the real id from the URL (lib/route-param.ts).
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function ChatPage() {
  return <ChatView />;
}
