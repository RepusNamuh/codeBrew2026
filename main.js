const { useEffect, useMemo, useRef, useState } = React;

const ZOOM_DURATION_MS = 520;
const LEAF_FOCUS_SCALE = 2.85;
const LEAF_FOCUS_TARGET_X = 32;
const LEAF_FOCUS_TARGET_Y = 50;
const DIMMED_NODE_LUMINOSITY = 0.5;
const INFO_PANEL_FIXED_WIDTH = 360;
const INFO_PANEL_RIGHT_GAP = 16;
const INFO_PANEL_TOP = 88;
const INFO_PANEL_BOTTOM = 14;

function clampRange(value, min, max) {
	if (max <= min) {
		return min;
	}
	return Math.min(max, Math.max(min, value));
}

function clampNumber(value, min, max, fallback) {
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	if (parsed < min) {
		return min;
	}
	if (parsed > max) {
		return max;
	}
	return parsed;
}

function normalizeNode(rawNode, fallbackId) {
	const luminosity =
		rawNode.nodeLuminosity ?? rawNode["node luminosity"] ?? rawNode["node lumnosity"];
	const nodeSize = rawNode.nodeSize ?? rawNode["node size"];
	const rawDescription =
		rawNode.description ?? rawNode.nodeDescription ?? rawNode["node description"];
	const rawNodeImage =
		rawNode.nodeImage ?? rawNode["node image"] ?? rawNode.image ?? rawNode.imageUrl;
	const rawChildren = rawNode.nodeChildren ?? rawNode["node children"];
	const children = Array.isArray(rawChildren) ? rawChildren : [];
	const position = rawNode.position || {};
	const nodeImage = typeof rawNodeImage === "string" ? rawNodeImage.trim() : "";
	const description = typeof rawDescription === "string" ? rawDescription.trim() : "";

	return {
		id: String(rawNode.id || fallbackId),
		name: rawNode.name || "Unnamed Node",
		nodeLuminosity: clampNumber(luminosity, 0.35, 2.2, 1),
		nodeSize: clampNumber(nodeSize, 8, 60, 18),
		description,
		nodeImage,
		position: {
			x: clampNumber(position.x, 0, 100, 50),
			y: clampNumber(position.y, 0, 100, 50),
		},
		nodeChildren: children.map((child, index) => normalizeNode(child, `${fallbackId}-${index}`)),
	};
}

function parseNodesPayload(payload) {
	const rawNodes = Array.isArray(payload) ? payload : payload.nodes;
	if (!Array.isArray(rawNodes)) {
		return [];
	}
	return rawNodes.map((node, index) => normalizeNode(node, `node-${index}`));
}

function getHaloCount(nodeSize) {
	if (nodeSize <= 14) {
		return 1;
	}
	if (nodeSize <= 19) {
		return 2;
	}
	if (nodeSize <= 26) {
		return 3;
	}
	if (nodeSize <= 34) {
		return 4;
	}
	return 5;
}

async function fetchNodes() {
	const response = await fetch("./nodes.json", { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Could not read nodes.json (status ${response.status})`);
	}
	const payload = await response.json();
	return parseNodesPayload(payload);
}

function App() {
	const [viewportSize, setViewportSize] = useState(() => {
		if (typeof window === "undefined") {
			return { width: 1280, height: 720 };
		}

		return {
			width: window.innerWidth,
			height: window.innerHeight,
		};
	});
	const [nodeStack, setNodeStack] = useState([]);
	const [pathStack, setPathStack] = useState(["Star Canvas"]);
	const [statusMessage, setStatusMessage] = useState("Loading nodes from nodes.json...");
	const [warningMessage, setWarningMessage] = useState("");
	const [selectedNode, setSelectedNode] = useState(null);
	const [hoveredNode, setHoveredNode] = useState(null);
	const [leafFocusNodeId, setLeafFocusNodeId] = useState(null);
	const [imageLoadState, setImageLoadState] = useState("none");
	const [isZooming, setIsZooming] = useState(false);
	const [camera, setCamera] = useState({ tx: 0, ty: 0, scale: 1 });
	const zoomTimerRef = useRef(null);

	useEffect(() => {
		let isMounted = true;

		fetchNodes()
			.then((loadedNodes) => {
				if (!isMounted) {
					return;
				}
				setNodeStack([loadedNodes]);
				setStatusMessage(
					"Hover nodes for names. Click a node with children to zoom into its cluster."
				);
			})
			.catch((error) => {
				if (!isMounted) {
					return;
				}
				setNodeStack([[]]);
				setWarningMessage(error.message);
				setStatusMessage(
					"Node data did not load. Serve this folder with a local HTTP server and retry."
				);
			});

		return () => {
			isMounted = false;
			if (zoomTimerRef.current) {
				window.clearTimeout(zoomTimerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") {
			return undefined;
		}

		let frameId = null;

		function handleResize() {
			if (frameId !== null) {
				window.cancelAnimationFrame(frameId);
			}

			frameId = window.requestAnimationFrame(() => {
				setViewportSize({
					width: window.innerWidth,
					height: window.innerHeight,
				});
				frameId = null;
			});
		}

		window.addEventListener("resize", handleResize, { passive: true });

		return () => {
			window.removeEventListener("resize", handleResize);
			if (frameId !== null) {
				window.cancelAnimationFrame(frameId);
			}
		};
	}, []);

	const activeNodes = useMemo(() => {
		if (nodeStack.length === 0) {
			return [];
		}
		return nodeStack[nodeStack.length - 1];
	}, [nodeStack]);

	const activeInfoNode = hoveredNode || selectedNode;

	useEffect(() => {
		if (!activeInfoNode) {
			setImageLoadState("none");
			return;
		}

		if (!activeInfoNode.nodeImage) {
			setImageLoadState("none");
			return;
		}

		setImageLoadState("loading");
	}, [activeInfoNode]);

	function runZoomTransition(nextAction) {
		setIsZooming(true);
		if (zoomTimerRef.current) {
			window.clearTimeout(zoomTimerRef.current);
		}
		zoomTimerRef.current = window.setTimeout(() => {
			nextAction();
			setCamera({ tx: 0, ty: 0, scale: 1 });
			setIsZooming(false);
		}, ZOOM_DURATION_MS);
	}

	function handleNodeClick(node) {
		if (isZooming) {
			return;
		}

		const childCount = node.nodeChildren.length;

		if (childCount > 0) {
			setSelectedNode(null);
			setHoveredNode(null);
			setLeafFocusNodeId(null);
			setStatusMessage(`Zooming into ${node.name} (${childCount} child nodes)...`);
			setCamera({
				tx: 50 - node.position.x,
				ty: 50 - node.position.y,
				scale: 2.15,
			});

			runZoomTransition(() => {
				setNodeStack((previousStack) => [...previousStack, node.nodeChildren]);
				setPathStack((previousPath) => [...previousPath, node.name]);
				setStatusMessage(
					`Viewing ${node.name}. ${childCount} child node${childCount === 1 ? "" : "s"} loaded.`
				);
			});
			return;
		}

		setSelectedNode(node);

		setLeafFocusNodeId(node.id);
		setCamera({
			tx: LEAF_FOCUS_TARGET_X - node.position.x,
			ty: LEAF_FOCUS_TARGET_Y - node.position.y,
			scale: LEAF_FOCUS_SCALE,
		});

		setStatusMessage(
			`${node.name} focused. Leaf node is highlighted while details are shown.`
		);
	}

	function handleCanvasClick() {
		if (isZooming) {
			return;
		}

		setSelectedNode(null);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setCamera({ tx: 0, ty: 0, scale: 1 });
		setStatusMessage("Selection cleared.");
	}

	function handleZoomOut() {
		if (isZooming || nodeStack.length <= 1) {
			return;
		}

		setSelectedNode(null);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setStatusMessage("Zooming out to parent cluster...");
		setCamera({ tx: 0, ty: 0, scale: 0.72 });

		runZoomTransition(() => {
			setNodeStack((previousStack) => previousStack.slice(0, -1));
			setPathStack((previousPath) => previousPath.slice(0, -1));
			setStatusMessage("Returned to parent cluster.");
		});
	}

	const layerTransform = `translate(${camera.tx}%, ${camera.ty}%) scale(${camera.scale})`;
	const canZoomOut = nodeStack.length > 1;
	const selectedNodeHasImage = Boolean(activeInfoNode && activeInfoNode.nodeImage);
	const showSelectedImage = selectedNodeHasImage && imageLoadState !== "error";
	const responsiveNodeScale = useMemo(() => {
		const base = Math.min(viewportSize.width / 1360, viewportSize.height / 900);
		return clampRange(base, 0.68, 1.35);
	}, [viewportSize.height, viewportSize.width]);
	const responsiveUiScale = useMemo(() => {
		const base = Math.min(viewportSize.width / 1280, viewportSize.height / 860);
		return clampRange(base, 0.76, 1.28);
	}, [viewportSize.height, viewportSize.width]);
	const appScaleStyle = useMemo(
		() => ({
			"--node-scale": responsiveNodeScale.toFixed(3),
			"--ui-scale": responsiveUiScale.toFixed(3),
		}),
		[responsiveNodeScale, responsiveUiScale]
	);
	const dimmingReferenceNode =
		hoveredNode || (selectedNode && selectedNode.nodeChildren.length === 0 ? selectedNode : null);
	const isHoverDimmingActive = Boolean(dimmingReferenceNode);
	const isLeafFocusActive = Boolean(leafFocusNodeId);
	const panelWidth = useMemo(() => {
		if (viewportSize.width <= 640) {
			return Math.min(320, Math.max(220, viewportSize.width - 24));
		}
		return Math.min(INFO_PANEL_FIXED_WIDTH, Math.max(220, viewportSize.width - 32));
	}, [viewportSize.width]);
	const detailPanelStyle = useMemo(
		() => ({
			left: "auto",
			width: `${Math.round(panelWidth)}px`,
			right: `${INFO_PANEL_RIGHT_GAP}px`,
			top: `${viewportSize.width <= 640 ? 72 : INFO_PANEL_TOP}px`,
			bottom: `${viewportSize.width <= 640 ? 10 : INFO_PANEL_BOTTOM}px`,
		}),
		[panelWidth, viewportSize.width]
	);
	return (
		<div className="app-shell" style={appScaleStyle}>
			<h1 className="canvas-title">Star Canvas</h1>

			{canZoomOut ? (
				<button type="button" className="cluster-back" onClick={handleZoomOut}>
					Back to Parent
				</button>
			) : null}

			<main className="star-canvas" aria-label="Historical Star Canvas" onClick={handleCanvasClick}>
				{activeNodes.length > 0 ? (
					<div className="node-layer" style={{ transform: layerTransform }}>
						{activeNodes.map((node) => {
							const childCount = node.nodeChildren.length;
							const hasChildrenClass = childCount > 0 ? " has-children" : "";
							const isDimmedByHover =
								isHoverDimmingActive && dimmingReferenceNode.id !== node.id;
							const isLeafFocusedNode = leafFocusNodeId === node.id;
							const dimmedClass = isDimmedByHover ? " is-dimmed" : "";
							const focusedClass = isLeafFocusedNode ? " is-leaf-focused" : "";
							const haloCount = getHaloCount(node.nodeSize);

							return (
								<button
									key={node.id}
									type="button"
									className={`star-node${hasChildrenClass}${dimmedClass}${focusedClass}`}
									aria-label={node.name}
									onClick={(event) => {
										event.stopPropagation();
										handleNodeClick(node);
									}}
									onMouseEnter={() => setHoveredNode(node)}
									onMouseLeave={() => {
										setHoveredNode((previousNode) =>
											previousNode && previousNode.id === node.id ? null : previousNode
										);
									}}
									onFocus={() => setHoveredNode(node)}
									onBlur={() => {
										setHoveredNode((previousNode) =>
											previousNode && previousNode.id === node.id ? null : previousNode
										);
									}}
									style={{
										left: `${node.position.x}%`,
										top: `${node.position.y}%`,
										"--node-size": node.nodeSize,
										"--node-luminosity": isDimmedByHover
											? DIMMED_NODE_LUMINOSITY
											: node.nodeLuminosity,
										"--halo-opacity-multiplier": isDimmedByHover ? 0.62 : 1,
									}}
								>
									<span className="star-halo" aria-hidden="true">
										{Array.from({ length: haloCount }).map((_, index) => (
											<span
												key={`${node.id}-halo-${index}`}
												className="star-halo-ring"
												style={{
													"--ring-scale": String(1.45 + index * 0.34),
													"--ring-opacity": String(Math.max(0.14, 0.34 - index * 0.05)),
													"--ring-blur": `${2 + index * 1.5}`,
													"--ring-delay": `${index * 130}ms`,
												}}
											/>
										))}
									</span>
									<span className="sr-only">
										{node.name}
										{childCount > 0 ? `, ${childCount} child nodes` : ""}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<div className="status-screen">No nodes to display.</div>
				)}
			</main>

			{activeInfoNode ? (
				<aside
					className="detail-panel"
					style={detailPanelStyle}
					aria-live="polite"
				>
					<h2 className="detail-title">{activeInfoNode.name}</h2>
					<p className="detail-meta">
						{`Children: ${activeInfoNode.nodeChildren.length} | Size: ${activeInfoNode.nodeSize} | Luminosity: ${activeInfoNode.nodeLuminosity.toFixed(2)}`}
					</p>
					<p className="detail-description">
						{activeInfoNode.description || "No description has been provided for this node yet."}
					</p>

					<div className="node-image-frame">
						{showSelectedImage ? (
							<>
								<img
									className="node-image"
									src={activeInfoNode.nodeImage}
									alt={`${activeInfoNode.name} preview`}
									onLoad={() => setImageLoadState("loaded")}
									onError={() => setImageLoadState("error")}
								/>
								{imageLoadState === "loading" ? (
									<p className="image-loading">Loading image...</p>
								) : null}
							</>
						) : (
							<p className="node-image-placeholder">
								No image found for this node yet. Add a node image URL or local path in
								nodes.json to show one here.
							</p>
						)}
					</div>
				</aside>
			) : null}

			<div className="hud">
				<p className="cluster-path">{pathStack.join(" / ")}</p>
				<p className="interaction-note" aria-live="polite">{statusMessage}</p>
				{isLeafFocusActive ? (
					<p className="leaf-return-hint">
						Leaf node focused. Click anywhere on empty canvas to return.
					</p>
				) : null}
				{warningMessage ? <p className="warning-note">{warningMessage}</p> : null}
			</div>
		</div>
	);
}

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(<App />);
