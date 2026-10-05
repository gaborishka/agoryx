type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** Technical prose may mention <script> without backticks. Keep its text visible. */
export function remarkLiteralHtml() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "html") node.type = "text";
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}
