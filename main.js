const { useEffect, useMemo, useRef, useState } = React;

// -----------------------------------------------------------------------------
// Section 1: App configuration
// -----------------------------------------------------------------------------

const ZOOM_DURATION_MS = 760;
const NODE_FOCUS_TARGET_X = 50;
const NODE_FOCUS_TARGET_Y = 50;
const PARENT_SCROLL_PROGRESS_STEP = 0.0024;
const MIN_SCROLL_PROGRESS_STEP = 0.03;
const SCROLL_REPOSITION_THRESHOLD_PX = 24;
const DIMMED_NODE_LUMINOSITY = 0.5;
const INFO_PANEL_FIXED_WIDTH = 360;
const INFO_PANEL_RIGHT_GAP = 16;
const INFO_PANEL_TOP = 88;
const INFO_PANEL_BOTTOM = 14;

// -----------------------------------------------------------------------------
// Section 2: Generic utility helpers
// -----------------------------------------------------------------------------

// Clamp a numeric value to the provided range.
function clampRange(value, min, max) {
	if (max <= min) {
		return min;
	}
	return Math.min(max, Math.max(min, value));
}

// Parse a value to number and constrain it. If invalid, return fallback.
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

// -----------------------------------------------------------------------------
// Section 3: Node data normalization and loading
// -----------------------------------------------------------------------------

// Normalize a node to the shape expected by the UI.
// Handles legacy field names and recursively normalizes children.
function normalizeNode(rawNode, fallbackId) {
	const luminosity = rawNode.nodeLuminosity;
	const nodeSize = rawNode.nodeSize;
	const rawDescription = rawNode.description;
	const rawNodeImage = rawNode.nodeImage;
	const rawZoomedBackground = rawNode.zoomedBackground ? rawNode.zoomedBackground : "";
	const rawChildren = rawNode.nodeChildren;
	const children = Array.isArray(rawChildren) ? rawChildren : [];
	const position = rawNode.position || {};
	const nodeImage = typeof rawNodeImage === "string" ? rawNodeImage.trim() : "";
	const zoomedBackground = typeof rawZoomedBackground === "string" ? rawZoomedBackground.trim() : "";
	const description = typeof rawDescription === "string" ? rawDescription.trim() : "";

	return {
		id: String(rawNode.id || fallbackId),
		name: rawNode.name || "Unnamed Node",
		nodeLuminosity: clampNumber(luminosity, 0.35, 2.2, 1),
		nodeSize: clampNumber(nodeSize, 8, 60, 18),
		description,
		nodeImage,
		zoomedBackground,
		position: {
			x: clampNumber(position.x, 0, 100, 50),
			y: clampNumber(position.y, 0, 100, 50),
		},
		nodeChildren: children.map((child, index) => normalizeNode(child, `${fallbackId}-${index}`)),
	};
}

// Accept either an array payload or { nodes: [...] } payload and normalize all entries.
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

// Fetch node data from disk and normalize it before handing it to the UI.
async function fetchNodes() {
	const response = await fetch("./nodes.json", { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Could not read nodes.json (status ${response.status})`);
	}
	const payload = await response.json();
	return parseNodesPayload(payload);
}

// -----------------------------------------------------------------------------
// Section 4: Main React component
// -----------------------------------------------------------------------------

function getWindowDimensions() {
	if (typeof window === "undefined") {
		return { width: 1280, height: 720};
	}
	return {
		width: window.innerWidth,
		height: window.innerHeight,
	}
}

function App() {
	// 4.1 - View state, interaction state, and animation state.
	const [viewportSize, setViewportSize] = useState(getWindowDimensions());

	const [nodeStack, setNodeStack] = useState([]);
	const [backgroundStack, setBackgroundStack] = useState([""]);
	const [pathStack, setPathStack] = useState(["Star Canvas"]);
	const [statusMessage, setStatusMessage] = useState("Loading nodes from nodes.json...");
	const [warningMessage, setWarningMessage] = useState("");
	const [selectedNode, setSelectedNode] = useState(null);
	const [hoveredNode, setHoveredNode] = useState(null);
	const [leafFocusNodeId, setLeafFocusNodeId] = useState(null);
	const [imageLoadState, setImageLoadState] = useState("none");
	const [isZooming, setIsZooming] = useState(false);
	const [parentScrollTransition, setParentScrollTransition] = useState(null);
	const [camera, setCamera] = useState({ tx: 0, ty: 0, scale: 1 });
	const zoomTimerRef = useRef(null);
	const lastPointerPositionRef = useRef({ x: null, y: null });
	const scrollStopGapRef = useRef({
		requireReposition: false,
		anchorX: null,
		anchorY: null,
	});

	// 4.2 - Initial data load.
	useEffect(() => {
		let isMounted = true;

		fetchNodes()
			.then((loadedNodes) => {
				if (!isMounted) {
					return;
				}
				setNodeStack([loadedNodes]);
				setBackgroundStack([""]);
				setStatusMessage(
					"Hover to inspect details. Click any node to center it. Hover a parent and scroll to blend into its child cluster."
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

	// 4.3 - Keep viewport size in sync with window size.
	// requestAnimationFrame is used to avoid excessive synchronous state updates.
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

	// The currently visible cluster is always the top of nodeStack.
	const activeNodes = useMemo(() => {
		if (nodeStack.length === 0) {
			return [];
		}
		return nodeStack[nodeStack.length - 1];
	}, [nodeStack]);

	const activeInfoNode = hoveredNode || selectedNode;

	// Keep track of image loading state so the detail panel can render feedback.
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

	// Wrap zoom transitions so cluster changes happen after the camera animation.
	function runZoomTransition(nextAction, options = {}) {
		const shouldResetCamera = options.resetCamera !== false;
		setIsZooming(true);
		if (zoomTimerRef.current) {
			window.clearTimeout(zoomTimerRef.current);
		}
		zoomTimerRef.current = window.setTimeout(() => {
			nextAction();
			if (shouldResetCamera) {
				setCamera({ tx: 0, ty: 0, scale: 1 });
			}
			setIsZooming(false);
		}, ZOOM_DURATION_MS);
	}

	function computeProgressStep(deltaY) {
		const scaledStep = Math.abs(deltaY) * PARENT_SCROLL_PROGRESS_STEP;
		return clampRange(scaledStep, MIN_SCROLL_PROGRESS_STEP, 0.34);
	}

	function activateScrollStopGap() {
		scrollStopGapRef.current = {
			requireReposition: true,
			anchorX: lastPointerPositionRef.current.x,
			anchorY: lastPointerPositionRef.current.y,
		};
	}

	function isScrollStopGapActive() {
		return scrollStopGapRef.current.requireReposition;
	}

	function handleCanvasMouseMove(event) {
		lastPointerPositionRef.current = {
			x: event.clientX,
			y: event.clientY,
		};

		if (!scrollStopGapRef.current.requireReposition) {
			return;
		}

		const { anchorX, anchorY } = scrollStopGapRef.current;

		if (anchorX === null || anchorY === null) {
			scrollStopGapRef.current.requireReposition = false;
			setStatusMessage(
				"Scroll-in rearmed. Hover or center a parent node and scroll up to blend into children."
			);
			return;
		}

		const deltaX = event.clientX - anchorX;
		const deltaY = event.clientY - anchorY;
		const movedDistance = Math.hypot(deltaX, deltaY);

		if (movedDistance < SCROLL_REPOSITION_THRESHOLD_PX) {
			return;
		}

		scrollStopGapRef.current.requireReposition = false;
		setStatusMessage(
			"Scroll-in rearmed. Hover or center a parent node and scroll up to blend into children."
		);
	}

	function finalizeParentTransition(parentNode) {
		const childCount = parentNode.nodeChildren.length;
		if (childCount === 0) {
			return;
		}

		setParentScrollTransition(null);
		setCamera({ tx: 0, ty: 0, scale: 1 });
		setSelectedNode(null);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setNodeStack((previousStack) => [...previousStack, parentNode.nodeChildren]);
		setBackgroundStack((previousStack) => [...previousStack, parentNode.zoomedBackground || ""]);
		setPathStack((previousPath) => [...previousPath, parentNode.name]);
		activateScrollStopGap();
		setStatusMessage(
			`Viewing ${parentNode.name}. ${childCount} child node${childCount === 1 ? "" : "s"} loaded. Move mouse to re-arm scroll-in.`
		);
	}

	function cancelParentTransition(parentNode) {
		setParentScrollTransition(null);
		setSelectedNode(parentNode);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setCamera({
			tx: NODE_FOCUS_TARGET_X - parentNode.position.x,
			ty: NODE_FOCUS_TARGET_Y - parentNode.position.y,
			scale: 1,
		});
		setStatusMessage(
			`${parentNode.name} centered. Scroll up to keep blending into the child cluster.`
		);
	}

	function advanceParentTransition(parentNode, direction, progressStep) {
		const currentProgress =
			parentScrollTransition && parentScrollTransition.parentNode.id === parentNode.id
				? parentScrollTransition.progress
				: 0;
		const nextProgress = clampRange(currentProgress + direction * progressStep, 0, 1);

		if (nextProgress <= 0) {
			cancelParentTransition(parentNode);
			return;
		}

		if (nextProgress >= 1) {
			finalizeParentTransition(parentNode);
			return;
		}

		setSelectedNode(parentNode);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setParentScrollTransition({ parentNode, progress: nextProgress });
		setStatusMessage(
			`Transitioning into ${parentNode.name}: ${Math.round(nextProgress * 100)}%. Midway is locked; keep scrolling to complete or reverse.`
		);
	}

	// Node click behavior:
	// - Every node click recenters that node and dims non-selected nodes.
	// - Parent nodes can then be expanded via wheel-scroll while hovered/selected.
	function handleNodeClick(node) {
		const isMidTransition =
			Boolean(parentScrollTransition) &&
			parentScrollTransition.progress > 0 &&
			parentScrollTransition.progress < 1;

		if (isZooming || isMidTransition) {
			return;
		}

		const childCount = node.nodeChildren.length;
		setParentScrollTransition(null);
		setSelectedNode(node);
		setLeafFocusNodeId(childCount === 0 ? node.id : null);
		setCamera({
			tx: NODE_FOCUS_TARGET_X - node.position.x,
			ty: NODE_FOCUS_TARGET_Y - node.position.y,
			scale: 1,
		});

		if (childCount > 0) {
			setStatusMessage(
				`${node.name} centered. Keep the cursor on this parent node and scroll up to zoom into children.`
			);
			return;
		}

		setStatusMessage(`${node.name} centered. Leaf node remains focused until canvas is clicked.`);
	}

	function handleCanvasWheel(event) {
		if (isZooming) {
			return;
		}

		const progressStep = computeProgressStep(event.deltaY);
		const direction = event.deltaY < 0 ? 1 : -1;
		const isScrollIn = direction > 0;

		if (parentScrollTransition) {
			event.preventDefault();
			advanceParentTransition(parentScrollTransition.parentNode, direction, progressStep);
			return;
		}

		if (isScrollIn && isScrollStopGapActive()) {
			event.preventDefault();
			setStatusMessage("Scroll stop-gap active. Move mouse to re-arm before scrolling into a parent node again.");
			return;
		}

		if (direction < 0 && nodeStack.length > 1) {
			event.preventDefault();
			handleZoomOut();
			return;
		}

		if (direction < 0) {
			return;
		}

		const hoveredParent =
			hoveredNode && hoveredNode.nodeChildren.length > 0 ? hoveredNode : null;
		const selectedParent =
			selectedNode && selectedNode.nodeChildren.length > 0 ? selectedNode : null;
		const zoomCandidate = hoveredParent || selectedParent;

		if (!zoomCandidate) {
			return;
		}

		const candidateIsVisible = activeNodes.some((node) => node.id === zoomCandidate.id);
		if (!candidateIsVisible) {
			return;
		}

		event.preventDefault();
		setSelectedNode(zoomCandidate);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setCamera({
			tx: NODE_FOCUS_TARGET_X - zoomCandidate.position.x,
			ty: NODE_FOCUS_TARGET_Y - zoomCandidate.position.y,
			scale: 1,
		});
		advanceParentTransition(zoomCandidate, direction, progressStep);
	}

	// Clicking empty canvas clears selection and camera focus.
	function handleCanvasClick() {
		if (isZooming) {
			return;
		}

		scrollStopGapRef.current.requireReposition = false;
		setParentScrollTransition(null);
		setSelectedNode(null);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setCamera({ tx: 0, ty: 0, scale: 1 });
		setStatusMessage("Selection cleared. Canvas returned to its original position.");
	}

	// Zoom out one level in the hierarchy.
	function handleZoomOut() {
		if (isZooming || nodeStack.length <= 1 || parentScrollTransition) {
			return;
		}

		scrollStopGapRef.current.requireReposition = false;
		setSelectedNode(null);
		setHoveredNode(null);
		setLeafFocusNodeId(null);
		setStatusMessage("Zooming out to parent cluster...");
		setCamera({ tx: 0, ty: 0, scale: 0.72 });

		runZoomTransition(() => {
			setNodeStack((previousStack) => previousStack.slice(0, -1));
			setBackgroundStack((previousStack) => previousStack.slice(0, -1));
			setPathStack((previousPath) => previousPath.slice(0, -1));
			setStatusMessage("Returned to parent cluster.");
		});
	}

	// 4.4 - Derived UI values for rendering.
	const transitionProgress = parentScrollTransition ? parentScrollTransition.progress : 0;
	const isParentTransitionActive = Boolean(parentScrollTransition);
	const isMidParentTransitionActive =
		isParentTransitionActive && transitionProgress > 0 && transitionProgress < 1;
	const interactionLocked = isZooming || isMidParentTransitionActive;
	const effectiveCamera = useMemo(() => {
		if (!parentScrollTransition) {
			return camera;
		}

		const centeredTx = NODE_FOCUS_TARGET_X - parentScrollTransition.parentNode.position.x;
		const centeredTy = NODE_FOCUS_TARGET_Y - parentScrollTransition.parentNode.position.y;
		const remainingBlend = 1 - parentScrollTransition.progress;

		return {
			tx: centeredTx * remainingBlend,
			ty: centeredTy * remainingBlend,
			scale: 1,
		};
	}, [camera, parentScrollTransition]);
	const layerTransform = `translate(${effectiveCamera.tx}%, ${effectiveCamera.ty}%) scale(${effectiveCamera.scale})`;
	const canZoomOut = nodeStack.length > 1;
	const activeClusterBackground = backgroundStack[backgroundStack.length - 1] || "";
	const transitionParentNode = parentScrollTransition ? parentScrollTransition.parentNode : null;
	const transitionBackground = transitionParentNode ? transitionParentNode.zoomedBackground : "";
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
	// Dimming is click-driven only, so hover keeps the rest of the screen unchanged.
	const dimmingReferenceNode = selectedNode;
	const isSelectionDimmingActive = Boolean(dimmingReferenceNode);
	const isLeafFocusActive = Boolean(leafFocusNodeId);
	const isNodeCenterFocusActive = Boolean(selectedNode) && !isParentTransitionActive;
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
	const transitionLayerStyle = useMemo(
		() => ({
			transform: layerTransform,
			"--transition-progress": transitionProgress.toFixed(3),
		}),
		[layerTransform, transitionProgress]
	);

	// 4.5 - Render.
	return (
		<div className="app-shell" style={appScaleStyle}>
			<h1 className="canvas-title">Star Canvas</h1>

			{canZoomOut ? (
				<button
					type="button"
					className="cluster-back"
					onClick={handleZoomOut}
					disabled={interactionLocked}
				>
					Back to Parent
				</button>
			) : null}

			<main
				className="star-canvas"
				aria-label="Historical Star Canvas"
				onClick={handleCanvasClick}
				onMouseMove={handleCanvasMouseMove}
				onWheel={handleCanvasWheel}
			>
				{activeClusterBackground ? (
					<div
						className={`cluster-background${isParentTransitionActive ? " is-parent-transitioning" : ""}`}
						style={{ transform: layerTransform }}
						aria-hidden="true"
					>
						<img
							className="cluster-background-image"
							src={activeClusterBackground}
							alt=""
						/>
					</div>
				) : null}

				{isParentTransitionActive ? (
					<div className="parent-transition-layer" style={transitionLayerStyle} aria-hidden="true">
						{transitionBackground ? (
							<div className="cluster-background transition-cluster-background">
								<img
									className="cluster-background-image transition-cluster-background-image"
									src={transitionBackground}
									alt=""
								/>
							</div>
						) : null}

						<div className="parent-transition-children">
							{transitionParentNode.nodeChildren.map((node) => {
								const haloCount = getHaloCount(node.nodeSize);

								return (
									<div
										key={`transition-${node.id}`}
										className="star-node transition-child-node"
										style={{
											left: `${node.position.x}%`,
											top: `${node.position.y}%`,
											"--node-size": node.nodeSize,
											"--node-luminosity": node.nodeLuminosity,
											"--halo-opacity-multiplier": 1,
										}}
									>
										<span className="star-halo" aria-hidden="true">
											{Array.from({ length: haloCount }).map((_, index) => (
												<span
													key={`transition-${node.id}-halo-${index}`}
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
									</div>
								);
							})}
						</div>
					</div>
				) : null}

				{activeNodes.length > 0 ? (
					<div
						className={`node-layer${interactionLocked ? " is-interaction-locked" : ""}${isParentTransitionActive ? " is-parent-transitioning" : ""}`}
						style={{
							transform: layerTransform,
							opacity: isParentTransitionActive ? 1 - transitionProgress * 0.88 : 1,
						}}
					>
						{activeNodes.map((node) => {
							// Node classes and CSS variables are derived from interaction state.
							const childCount = node.nodeChildren.length;
							const hasChildrenClass = childCount > 0 ? " has-children" : "";
							const isDimmedBySelection =
								isSelectionDimmingActive && dimmingReferenceNode.id !== node.id;
							const isParentZoomingNode =
								isParentTransitionActive &&
								dimmingReferenceNode &&
								dimmingReferenceNode.id === node.id &&
								childCount > 0;
							const isLeafFocusedNode = leafFocusNodeId === node.id;
							const dimmedClass = isDimmedBySelection ? " is-dimmed" : "";
							const selectedClass =
								dimmingReferenceNode && dimmingReferenceNode.id === node.id ? " is-selected" : "";
							const parentZoomingClass = isParentZoomingNode ? " is-parent-zooming" : "";
							const focusedClass = isLeafFocusedNode ? " is-leaf-focused" : "";
							const haloCount = getHaloCount(node.nodeSize);

							return (
								<button
									key={node.id}
									type="button"
									className={`star-node${hasChildrenClass}${dimmedClass}${selectedClass}${parentZoomingClass}${focusedClass}`}
									aria-label={node.name}
									disabled={interactionLocked}
									onClick={(event) => {
										event.stopPropagation();
										handleNodeClick(node);
									}}
									onMouseEnter={() => {
										if (!interactionLocked) {
											setHoveredNode(node);
										}
									}}
									onMouseLeave={() => {
										if (!interactionLocked) {
											setHoveredNode((previousNode) =>
												previousNode && previousNode.id === node.id ? null : previousNode
											);
										}
									}}
									onFocus={() => {
										if (!interactionLocked) {
											setHoveredNode(node);
										}
									}}
									onBlur={() => {
										if (!interactionLocked) {
											setHoveredNode((previousNode) =>
												previousNode && previousNode.id === node.id ? null : previousNode
											);
										}
									}}
									style={{
										left: `${node.position.x}%`,
										top: `${node.position.y}%`,
										"--node-size": node.nodeSize,
										// Dim only non-target nodes while preserving each node's base luminosity.
										"--node-luminosity": isDimmedBySelection
											|| isParentZoomingNode
											? DIMMED_NODE_LUMINOSITY
											: node.nodeLuminosity,
										"--halo-opacity-multiplier":
											isDimmedBySelection || isParentZoomingNode ? 0.62 : 1,
									}}
								>
									<span className="star-halo" aria-hidden="true">
										{/* Render layered halo rings for a more dynamic star glow. */}
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
				{!isLeafFocusActive && isNodeCenterFocusActive ? (
					<p className="leaf-return-hint">
						Node centered. Click empty canvas to reset camera.
					</p>
				) : null}
				{warningMessage ? <p className="warning-note">{warningMessage}</p> : null}
			</div>
		</div>
	);
}

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(<App />);
