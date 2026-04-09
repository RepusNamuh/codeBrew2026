const { useEffect, useMemo, useRef, useState } = React;

const ZOOM_DURATION_MS = 520;
const LEAF_FOCUS_SCALE = 2.85;
const LEAF_FOCUS_TARGET_X = 32;
const LEAF_FOCUS_TARGET_Y = 50;
const DIMMED_NODE_LUMINOSITY = 0.5;
const MIN_DETAIL_PANEL_WIDTH = 280;
const MAX_DETAIL_PANEL_WIDTH = 540;

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

function rectanglesOverlap(rectA, rectB) {
	return (
		rectA.left < rectB.right &&
		rectA.right > rectB.left &&
		rectA.top < rectB.bottom &&
		rectA.bottom > rectB.top
	);
}

function rectangleOverlapArea(rectA, rectB) {
	const overlapWidth = Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left));
	const overlapHeight = Math.max(0, Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top));
	return overlapWidth * overlapHeight;
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

		setSelectedNode(node);

		const childCount = node.nodeChildren.length;

		if (childCount > 0) {
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
	const detailPanelLayout = useMemo(() => {
		if (!activeInfoNode) {
			return null;
		}

		const margin = 16;
		const topSafePadding = viewportSize.width < 700 ? 76 : 102;
		const gap = Math.max(14, Math.round(16 * responsiveUiScale));
		const viewportMaxPanelWidth = Math.max(180, viewportSize.width - margin * 2);
		const minPanelWidth = Math.min(MIN_DETAIL_PANEL_WIDTH, viewportMaxPanelWidth);
		const preferredPanelWidth = clampRange(
			viewportSize.width * (isLeafFocusActive ? 0.36 : 0.33),
			minPanelWidth,
			Math.min(MAX_DETAIL_PANEL_WIDTH, viewportMaxPanelWidth)
		);
		const availableHeight = Math.max(170, viewportSize.height - topSafePadding - margin);
		const preferredPanelHeight = Math.floor(
			viewportSize.height * (isLeafFocusActive ? 0.72 : 0.76)
		);
		const panelHeight = Math.min(preferredPanelHeight, availableHeight);

		const nodePercentX = clampRange(activeInfoNode.position.x + camera.tx, 0, 100);
		const nodePercentY = clampRange(activeInfoNode.position.y + camera.ty, 0, 100);
		const nodePixelX = (viewportSize.width * nodePercentX) / 100;
		const nodePixelY = (viewportSize.height * nodePercentY) / 100;
		const nodeRadius = Math.max(
			14,
			(activeInfoNode.nodeSize * responsiveNodeScale * Math.max(1, camera.scale)) / 2 + 12
		);
		const nodeExclusionRect = {
			left: nodePixelX - nodeRadius,
			right: nodePixelX + nodeRadius,
			top: nodePixelY - nodeRadius,
			bottom: nodePixelY + nodeRadius,
		};

		const availableRight = Math.max(0, viewportSize.width - (nodePixelX + gap) - margin);
		const availableLeft = Math.max(0, nodePixelX - gap - margin);
		const widthRight = Math.min(preferredPanelWidth, availableRight);
		const widthLeft = Math.min(preferredPanelWidth, availableLeft);
		const widthVertical = Math.min(preferredPanelWidth, viewportMaxPanelWidth);
		const minTop = Math.max(margin, topSafePadding);
		const maxTop = Math.max(minTop, viewportSize.height - panelHeight - margin);
		const maxLeft = Math.max(margin, viewportSize.width - widthVertical - margin);

		const candidatesBySide = {
			right: null,
			left: null,
			top: null,
			bottom: null,
		};

		if (widthRight >= 80) {
			const top = clampRange(nodePixelY - panelHeight * 0.5, minTop, maxTop);
			const left = clampRange(nodePixelX + gap, margin, viewportSize.width - widthRight - margin);
			candidatesBySide.right = {
				side: "right",
				left,
				top,
				width: widthRight,
				height: panelHeight,
				right: left + widthRight,
				bottom: top + panelHeight,
			};
		}

		if (widthLeft >= 80) {
			const top = clampRange(nodePixelY - panelHeight * 0.5, minTop, maxTop);
			const left = clampRange(nodePixelX - gap - widthLeft, margin, viewportSize.width - widthLeft - margin);
			candidatesBySide.left = {
				side: "left",
				left,
				top,
				width: widthLeft,
				height: panelHeight,
				right: left + widthLeft,
				bottom: top + panelHeight,
			};
		}

		{
			const top = clampRange(nodePixelY - gap - panelHeight, minTop, maxTop);
			const left = clampRange(nodePixelX - widthVertical * 0.5, margin, maxLeft);
			candidatesBySide.top = {
				side: "top",
				left,
				top,
				width: widthVertical,
				height: panelHeight,
				right: left + widthVertical,
				bottom: top + panelHeight,
			};
		}

		{
			const top = clampRange(nodePixelY + gap, minTop, maxTop);
			const left = clampRange(nodePixelX - widthVertical * 0.5, margin, maxLeft);
			candidatesBySide.bottom = {
				side: "bottom",
				left,
				top,
				width: widthVertical,
				height: panelHeight,
				right: left + widthVertical,
				bottom: top + panelHeight,
			};
		}

		const sidePriority =
			availableRight >= availableLeft
				? ["right", "left", "top", "bottom"]
				: ["left", "right", "top", "bottom"];
		const orderedCandidates = sidePriority
			.map((sideKey) => candidatesBySide[sideKey])
			.filter(Boolean);
		const nonOverlappingCandidate = orderedCandidates.find(
			(candidate) => candidate && !rectanglesOverlap(candidate, nodeExclusionRect)
		);
		let selectedPlacement = nonOverlappingCandidate;

		if (!selectedPlacement) {
			selectedPlacement = orderedCandidates
				.filter(Boolean)
				.sort(
					(candidateA, candidateB) =>
						rectangleOverlapArea(candidateA, nodeExclusionRect) -
						rectangleOverlapArea(candidateB, nodeExclusionRect)
				)[0];
		}

		if (!selectedPlacement) {
			return {
				side: "right",
				style: {
					left: `${margin}px`,
					top: `${minTop}px`,
					width: `${Math.round(Math.min(preferredPanelWidth, viewportMaxPanelWidth))}px`,
					maxHeight: `${Math.round(panelHeight)}px`,
				},
			};
		}

		let resolvedPlacement = selectedPlacement;
		if (rectanglesOverlap(resolvedPlacement, nodeExclusionRect)) {
			const canPlaceBelowNode = nodeExclusionRect.bottom + gap + panelHeight <= viewportSize.height - margin;
			const canPlaceAboveNode = nodeExclusionRect.top - gap - panelHeight >= minTop;

			if (canPlaceBelowNode) {
				const top = nodeExclusionRect.bottom + gap;
				resolvedPlacement = {
					...resolvedPlacement,
					top,
					bottom: top + panelHeight,
				};
			} else if (canPlaceAboveNode) {
				const top = nodeExclusionRect.top - gap - panelHeight;
				resolvedPlacement = {
					...resolvedPlacement,
					top,
					bottom: top + panelHeight,
				};
			}
		}

		return {
			side: resolvedPlacement.side,
			style: {
				left: `${Math.round(resolvedPlacement.left)}px`,
				top: `${Math.round(resolvedPlacement.top)}px`,
				width: `${Math.round(resolvedPlacement.width)}px`,
				maxHeight: `${Math.round(resolvedPlacement.height)}px`,
			},
		};
	}, [
		activeInfoNode,
		camera.tx,
		camera.ty,
		camera.scale,
		isLeafFocusActive,
		responsiveNodeScale,
		responsiveUiScale,
		viewportSize.height,
		viewportSize.width,
	]);
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
					style={detailPanelLayout ? detailPanelLayout.style : undefined}
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
