import { DrawView } from "./draw-view";

// Same placeholder strategy as /chat/[id]: the view reads the real slug from the URL.
export function generateStaticParams() {
  return [{ slug: "_" }];
}

export default function DrawPage() {
  return <DrawView />;
}
