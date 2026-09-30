import qrcode from "qrcode-generator";

/** A QR code's modules (true = dark), for the pairing link: the terminal and the UI draw the same one. */
export const qrMatrix = (text: string): boolean[][] => {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
};

const QUIET = 2;

/** Dark on white with a quiet zone, scalable (no width/height): the page sizes it. */
export const qrSvg = (text: string): string => {
  const matrix = qrMatrix(text);
  const size = matrix.length + QUIET * 2;
  let path = "";
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
};

/**
 * Two rows of modules per line with half blocks. With `color`, black on a white background whatever the
 * terminal's theme; without (a pipe), white is drawn and dark left blank, which suits a dark terminal.
 */
export const qrTerminal = (text: string, options: { color?: boolean } = {}): string => {
  const matrix = qrMatrix(text);
  const size = matrix.length + QUIET * 2;
  const dark = (row: number, col: number): boolean => matrix[row - QUIET]?.[col - QUIET] ?? false;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = row + 1 < size ? dark(row + 1, col) : false;
      line += options.color
        ? top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
        : !top && !bottom ? "█" : !top ? "▀" : !bottom ? "▄" : " ";
    }
    lines.push(options.color ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
};
