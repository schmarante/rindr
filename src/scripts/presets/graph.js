// Small builder for the node graphs of library presets (presets/<category>.js):
//   const g = graph({ size: 750, relief: 1 });
//   const t = g.node('tiles', { pattern: 'running', countU: 3, countV: 10 });
//   g.out(t, 'color', 'color').out(t, 'value', 'height');
//   … graph: g.done()
// Nodes are laid out in a grid left of the output (readable in the node editor). Pure – no three.js.

export function graph({ size = 100, relief = 1 } = {}) {
    const nodes = [{ id: 'out', type: 'output', x: 900, y: 40, params: { reliefStrength: relief, size } }];
    const links = [];
    let n = 0;
    const api = {
        /** add a node, returns its id */
        node(type, params = {}) {
            const i = n++;
            const id = `${type}-${i + 1}`;
            nodes.push({ id, type, x: 40 + (i % 3) * 270, y: 40 + Math.floor(i / 3) * 240, params });
            return id;
        },
        /** link output `port` of node `from` to input `toPort` of node `to` */
        link(from, port, to, toPort) {
            links.push({ from: { node: from, port }, to: { node: to, port: toPort } });
            return api;
        },
        /** link to an input of the material output */
        out(from, port, input) {
            return api.link(from, port, 'out', input);
        },
        done() {
            return { nodes, links };
        },
    };
    return api;
}
