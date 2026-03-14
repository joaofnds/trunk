<!--
    @component VirtualList

    Vendored and trimmed virtual list for Trunk.
    Top-to-bottom only, with overlay snippet slot for SVG overlay.
    Based on @humanspeak/svelte-virtual-list.
-->

<script lang="ts" generics="TItem = unknown">
    import {
        DEFAULT_SCROLL_OPTIONS,
        type SvelteVirtualListPreviousVisibleRange,
        type SvelteVirtualListScrollOptions
    } from './virtual-list/types.js'
    import { calculateAverageHeightDebounced } from './virtual-list/utils/heightCalculation.js'
    import { createRafScheduler } from './virtual-list/utils/raf.js'
    import { isSignificantHeightChange } from './virtual-list/utils/heightChangeDetection.js'
    import {
        calculateTransformY,
        calculateVisibleRange,
        clampValue,
        updateHeightAndScroll as utilsUpdateHeightAndScroll,
    } from './virtual-list/utils/virtualList.js'
    import { createDebugInfo, shouldShowDebugInfo } from './virtual-list/utils/virtualListDebug.js'
    import { calculateScrollTarget } from './virtual-list/utils/scrollCalculation.js'
    import { createAdvancedThrottledCallback } from './virtual-list/utils/throttle.js'
    import { ReactiveListManager } from './virtual-list/reactive-list-manager/index.js'
    import { BROWSER } from 'esm-env'
    import type { Snippet } from 'svelte'
    import { onMount, tick, untrack } from 'svelte'

    const rafSchedule = createRafScheduler()
    const mode = 'topToBottom' as const

    interface Props {
        items?: TItem[]
        defaultEstimatedItemHeight?: number
        debug?: boolean
        renderItem: Snippet<[TItem, number]>
        bufferSize?: number
        onLoadMore?: () => void | Promise<void>
        loadMoreThreshold?: number
        hasMore?: boolean
        overlaySnippet?: Snippet<[contentHeight: number, visibleStart: number, visibleEnd: number]>
    }

    const {
        items = [],
        defaultEstimatedItemHeight = 40,
        debug = false,
        renderItem,
        bufferSize = 20,
        onLoadMore,
        loadMoreThreshold = 20,
        hasMore = true,
        overlaySnippet,
    }: Props = $props()

    /**
     * DOM References and Core State
     */
    const itemElements = $state<HTMLElement[]>([])

    /**
     * Scroll and Height Management
     */
    let height = $state(0)

    /**
     * State Flags and Control
     */
    const isCalculatingHeight = $state(false)
    let isLoadingMore = $state(false)
    let isScrolling = $state(false)
    let scrollIdleTimer: number | null = null

    let lastMeasuredIndex = $state(-1)
    let lastScrollTopSnapshot = $state(0)

    /**
     * Timers and Observers
     */
    let heightUpdateTimeout: ReturnType<typeof setTimeout> | null = null
    let resizeObserver: ResizeObserver | null = null
    let itemResizeObserver: ResizeObserver | null = null

    /**
     * Performance Optimization State
     */
    const dirtyItems = $state(new Set<number>())
    let dirtyItemsCount = $state(0)
    let measuredFallbackHeight = $state(0)
    let lastProcessedScrollTop = $state(0)

    let prevVisibleRange = $state<SvelteVirtualListPreviousVisibleRange | null>(null)
    let prevHeight = $state<number>(0)
    let prevTotalHeightForScrollCorrection = $state<number>(0)

    /**
     * Reactive Height Manager - O(1) height calculation system
     */
    const heightManager = new ReactiveListManager({
        itemLength: items.length,
        itemHeight: defaultEstimatedItemHeight,
        internalDebug: false
    })

    // Centralized debug logger
    const log = (tag: string, payload?: unknown) => {
        if (!debug) return
        try {
            const ts = new Date().toISOString().split('T')[1]?.replace('Z', '')
            console.info(`[VL] ${ts} ${tag}`, payload ?? '')
        } catch {
            // no-op
        }
    }

    /**
     * Synchronizes the scroll position between the viewport element and internal state.
     */
    const syncScrollTop = (value: number, round = false) => {
        if (!heightManager.viewportElement) return
        const scrollValue = round ? Math.round(value) : value
        heightManager.viewport.scrollTop = scrollValue
        heightManager.scrollTop = scrollValue
    }

    /**
     * Handles scroll position corrections when item heights change.
     */
    const handleHeightChangesScrollCorrection = (
        heightChanges: Array<{ index: number; oldHeight: number; newHeight: number; delta: number }>
    ) => {
        if (!heightManager.viewportElement || !heightManager.initialized) {
            return
        }
        // Coalesce adjustments during active scroll; apply on idle
        if (isScrolling) {
            let pending = 0
            const currentVisibleRange = visibleItems
            for (const change of heightChanges) {
                if (change.index < currentVisibleRange.start) pending += change.delta
            }
            if (pending !== 0) {
                const key = '__svl_pendingHeightAdj__' as unknown as keyof HTMLElement
                const prev = (heightManager.viewport as unknown as Record<string, number>)[
                    key as string
                ] as number | undefined
                ;(heightManager.viewport as unknown as Record<string, number>)[key as string] =
                    (prev ?? 0) + pending
            }
            return
        }

        const currentScrollTop = heightManager.viewport.scrollTop
        const maxScrollTop = Math.max(0, totalHeight - height)

        let heightChangeAboveViewport = 0
        const currentVisibleRange = visibleItems

        for (const change of heightChanges) {
            if (change.index < currentVisibleRange.start) {
                heightChangeAboveViewport += change.delta
            }
        }

        // Include any pending coalesced delta
        {
            const key = '__svl_pendingHeightAdj__' as unknown as keyof HTMLElement
            const pending =
                (heightManager.viewport as unknown as Record<string, number>)[key as string] ?? 0
            if (pending) {
                heightChangeAboveViewport += pending
                ;(heightManager.viewport as unknown as Record<string, number>)[key as string] = 0
            }
        }
        if (Math.abs(heightChangeAboveViewport) > 2) {
            const newScrollTop = clampValue(
                currentScrollTop + heightChangeAboveViewport,
                0,
                maxScrollTop
            )
            syncScrollTop(newScrollTop)
        }
    }

    // Throttled height update function
    const triggerHeightUpdate = createAdvancedThrottledCallback(
        () => {
            if (BROWSER && dirtyItemsCount > 0) {
                wasAtBottomBeforeHeightChange = atBottom
                heightManager.startDynamicUpdate()
                updateHeight()
            }
        },
        16,
        {
            leading: true,
            trailing: true
        }
    )

    // Trigger height calculation when dirty items are added
    $effect(() => {
        triggerHeightUpdate()
    })

    // Keep height manager synchronized with items length
    $effect(() => {
        heightManager.updateItemLength(items.length)
        stabilizedContentHeight = 0
    })

    // Infinite scroll: trigger onLoadMore when approaching end of list
    $effect(() => {
        if (!BROWSER || !onLoadMore || !hasMore || isLoadingMore) return

        const range = visibleItems
        const atLoadingEdge = range.end >= items.length - loadMoreThreshold
        const insufficientItems = items.length < loadMoreThreshold && heightManager.initialized

        if (atLoadingEdge || insufficientItems) {
            isLoadingMore = true
            Promise.resolve(onLoadMore()).finally(() => {
                isLoadingMore = false
            })
        }
    })

    const updateHeight = () => {
        prevTotalHeightForScrollCorrection = heightManager.totalHeight
        heightUpdateTimeout = calculateAverageHeightDebounced(
            isCalculatingHeight,
            heightUpdateTimeout,
            visibleItems,
            itemElements,
            heightManager.getHeightCache(),
            lastMeasuredIndex,
            heightManager.averageHeight,
            (result) => {
                if (result.newValidCount !== 1) {
                    heightManager.itemHeight = result.newHeight
                }
                lastMeasuredIndex = result.newLastMeasuredIndex

                if (result.heightChanges.length > 0) {
                    heightManager.processDirtyHeights(result.heightChanges)
                }

                // TopToBottom: maintain bottom anchoring when total height changes
                if (heightManager.isReady && heightManager.initialized) {
                    const oldTotal = prevTotalHeightForScrollCorrection
                    const newTotal = heightManager.totalHeight
                    const deltaTotal = newTotal - oldTotal
                    if (Math.abs(deltaTotal) > 1) {
                        const maxScrollTop = Math.max(0, newTotal - (height || 0))
                        const tolerance = Math.max(heightManager.averageHeight, 10)
                        const currentScrollTop = heightManager.viewport.scrollTop
                        const isAtBottom = Math.abs(currentScrollTop - maxScrollTop) <= tolerance
                        if (isAtBottom) {
                            const adjusted = clampValue(
                                currentScrollTop + deltaTotal,
                                0,
                                maxScrollTop
                            )
                            syncScrollTop(adjusted, true)
                        }
                    }
                }

                untrack(() => {
                    dirtyItems.clear()
                    dirtyItemsCount = 0
                    wasAtBottomBeforeHeightChange = false
                })
                heightManager.endDynamicUpdate()
            },
            lastMeasuredIndex < 0 || dirtyItems.size > 0 ? 0 : 100,
            dirtyItems,
            0,
            0,
            mode
        )
    }

    let programmaticScrollInProgress = $state(false)

    const totalHeight = $derived(heightManager.totalHeight)

    const atBottom = $derived(heightManager.scrollTop >= totalHeight - height - 1)
    let wasAtBottomBeforeHeightChange = false
    let lastVisibleRange: SvelteVirtualListPreviousVisibleRange | null = null

    // Update container height continuously
    $effect(() => {
        if (BROWSER && heightManager.isReady) {
            const h = heightManager.container.getBoundingClientRect().height
            if (Number.isFinite(h) && h > 0) height = h
        }
    })

    // One-time fallback measurement when height hasn't been established yet
    $effect(() => {
        if (BROWSER && height === 0 && heightManager.isReady) {
            const h = heightManager.container.getBoundingClientRect().height
            if (Number.isFinite(h) && h > 0) measuredFallbackHeight = h
        }
    })

    /**
     * Calculates the range of items that should be rendered.
     */
    const visibleItems = $derived.by((): SvelteVirtualListPreviousVisibleRange => {
        if (!items.length) return { start: 0, end: 0 } as SvelteVirtualListPreviousVisibleRange
        const viewportHeight = height || 0

        // Scroll delta threshold optimization
        const scrollDelta = Math.abs(heightManager.scrollTop - lastProcessedScrollTop)
        const threshold = heightManager.averageHeight * 0.5
        if (lastVisibleRange && scrollDelta < threshold && scrollDelta > 0) {
            return lastVisibleRange
        }

        lastVisibleRange = calculateVisibleRange(
            heightManager.scrollTop,
            viewportHeight,
            heightManager.averageHeight,
            items.length,
            bufferSize,
            mode,
            atBottom,
            wasAtBottomBeforeHeightChange,
            lastVisibleRange,
            totalHeight,
            heightManager.getHeightCache()
        )

        return lastVisibleRange
    })

    let stabilizedContentHeight = 0

    const contentHeight = $derived.by(() => {
        const raw = Math.max(height, totalHeight)
        stabilizedContentHeight = raw
        return raw
    })

    /**
     * Computed transform Y value for positioning the visible items.
     */
    const transformY = $derived.by(() => {
        const viewportHeight = height || measuredFallbackHeight || 0
        const visibleRange = visibleItems
        const effectiveHeight = viewportHeight === 0 ? 400 : viewportHeight

        return Math.round(
            calculateTransformY(
                mode,
                items.length,
                visibleRange.end,
                visibleRange.start,
                heightManager.averageHeight,
                effectiveHeight,
                totalHeight,
                heightManager.getHeightCache(),
                measuredFallbackHeight
            )
        )
    })

    const displayItems = $derived.by(() => {
        const visibleRange = visibleItems
        const slice = items.slice(visibleRange.start, visibleRange.end)

        return slice.map((item, sliceIndex) => ({
            item,
            originalIndex: visibleRange.start + sliceIndex,
            sliceIndex
        }))
    })

    /**
     * Handles scroll events in the viewport using requestAnimationFrame.
     */
    const handleScroll = () => {
        if (!BROWSER || !heightManager.viewportElement) return

        isScrolling = true
        if (scrollIdleTimer) {
            clearTimeout(scrollIdleTimer)
            scrollIdleTimer = null
        }
        scrollIdleTimer = window.setTimeout(() => {
            isScrolling = false
        }, 250)

        rafSchedule(() => {
            const current = heightManager.viewport.scrollTop
            lastScrollTopSnapshot = current
            heightManager.scrollTop = current
            const scrollDelta = Math.abs(current - lastProcessedScrollTop)
            const threshold = heightManager.averageHeight * 0.5
            if (scrollDelta >= threshold || lastVisibleRange === null) {
                lastProcessedScrollTop = current
            }
        })
    }

    /**
     * Updates the height and scroll position of the virtual list.
     */
    const updateHeightAndScroll = (immediate = false) => {
        utilsUpdateHeightAndScroll(
            {
                initialized: heightManager.initialized,
                mode,
                containerElement: heightManager.containerElement,
                viewportElement: heightManager.viewportElement,
                calculatedItemHeight: heightManager.averageHeight,
                height,
                scrollTop: heightManager.scrollTop
            },
            {
                setHeight: (h) => (height = h),
                setScrollTop: (st) => (heightManager.scrollTop = st),
                setInitialized: (i) => {
                    if (i && heightManager.initialized) return
                    heightManager.initialized = i
                }
            },
            immediate
        )
    }

    // Create itemResizeObserver immediately when in browser
    if (BROWSER) {
        itemResizeObserver = new ResizeObserver((entries) => {
            rafSchedule(() => {
                let shouldRecalculate = false
                void visibleItems

                for (const entry of entries) {
                    const element = entry.target as HTMLElement
                    const elementIndex = itemElements.indexOf(element)
                    const actualIndex = parseInt(element.dataset.originalIndex || '-1', 10)

                    if (elementIndex !== -1) {
                        if (actualIndex >= 0) {
                            const currentHeight = element.getBoundingClientRect().height
                            const isSignificant = isSignificantHeightChange(
                                actualIndex,
                                currentHeight,
                                heightManager.getHeightCache()
                            )

                            if (isSignificant) {
                                if (dirtyItemsCount === 0) {
                                    wasAtBottomBeforeHeightChange = atBottom
                                }

                                dirtyItems.add(actualIndex)
                                dirtyItemsCount = dirtyItems.size
                                shouldRecalculate = true
                            }
                        }
                    }
                }

                if (shouldRecalculate) {
                    updateHeight()
                }
            })
        })
    }

    // Setup and cleanup
    onMount(() => {
        if (BROWSER) {
            updateHeightAndScroll()
            tick().then(() =>
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        updateHeight()
                    })
                )
            )

            resizeObserver = new ResizeObserver(() => {
                if (!heightManager.initialized) return
                updateHeightAndScroll(true)
            })

            if (heightManager.isReady) {
                resizeObserver.observe(heightManager.container)
            }

            return () => {
                if (resizeObserver) {
                    resizeObserver.disconnect()
                }
                if (itemResizeObserver) {
                    itemResizeObserver.disconnect()
                }
            }
        }
    })

    // Debug info effect
    $effect(() => {
        if (!debug) return
        const currentVisibleRange = visibleItems
        if (
            !shouldShowDebugInfo(
                prevVisibleRange,
                currentVisibleRange,
                prevHeight,
                heightManager.averageHeight
            )
        )
            return

        const info = createDebugInfo(
            currentVisibleRange,
            items.length,
            Object.keys(heightManager.getHeightCache()).length,
            heightManager.averageHeight,
            heightManager.scrollTop,
            height || 0,
            totalHeight
        )

        console.info('Virtual List Debug:', info)
    })

    /**
     * Scrolls the virtual list to the item at the given index.
     */
    export const scroll = async (options: SvelteVirtualListScrollOptions): Promise<void> => {
        const { index, smoothScroll, shouldThrowOnBounds, align } = {
            ...DEFAULT_SCROLL_OPTIONS,
            ...options
        }

        if (!items.length) return
        if (!heightManager.viewportElement) {
            tick().then(() => {
                if (!heightManager.viewportElement) return
                scroll({ index, smoothScroll, shouldThrowOnBounds, align })
            })
            return
        }

        let targetIndex = index
        if (targetIndex < 0 || targetIndex >= items.length) {
            if (shouldThrowOnBounds) {
                throw new Error(
                    `scroll: index ${targetIndex} is out of bounds (0-${items.length - 1})`
                )
            } else {
                targetIndex = clampValue(targetIndex, 0, items.length - 1)
            }
        }

        const { start: firstVisibleIndex, end: lastVisibleIndex } = visibleItems

        const scrollTarget = calculateScrollTarget({
            mode,
            align: align || 'auto',
            targetIndex,
            itemsLength: items.length,
            calculatedItemHeight: heightManager.averageHeight,
            height,
            scrollTop: heightManager.scrollTop,
            firstVisibleIndex,
            lastVisibleIndex,
            heightCache: heightManager.getHeightCache()
        })

        if (scrollTarget === null) {
            return
        }

        programmaticScrollInProgress = true

        heightManager.viewport.scrollTo({
            top: scrollTarget,
            behavior: smoothScroll ? 'smooth' : 'auto'
        })

        requestAnimationFrame(() => {
            heightManager.scrollTop = scrollTarget
        })

        setTimeout(
            () => {
                programmaticScrollInProgress = false
            },
            smoothScroll ? 500 : 100
        )
    }

    /**
     * Custom Svelte action to automatically observe item elements for size changes.
     */
    function autoObserveItemResize(element: HTMLElement) {
        if (itemResizeObserver) {
            itemResizeObserver.observe(element)
        }

        return {
            destroy() {
                if (itemResizeObserver) {
                    itemResizeObserver.unobserve(element)
                }
            }
        }
    }
</script>

<!--
    Four-layer DOM structure:
    1. Container - Overall boundary
    2. Viewport - Scrollable area
    3. Content - Full height container (+ overlay snippet)
    4. Items - Translated list of visible items
-->
<div
    class="virtual-list-container"
    bind:this={heightManager.containerElement}
>
    <div
        class="virtual-list-viewport"
        bind:this={heightManager.viewportElement}
        onscroll={handleScroll}
        style:overflow-anchor="none"
    >
        <div
            class="virtual-list-content"
            style:height="{contentHeight}px"
        >
            {#if overlaySnippet}
                {@render overlaySnippet(contentHeight, visibleItems.start, visibleItems.end)}
            {/if}
            <div
                class="virtual-list-items"
                style:transform="translateY({transformY}px)"
            >
                {#each displayItems as currentItemWithIndex, _i (currentItemWithIndex.originalIndex)}
                    <div
                        bind:this={itemElements[currentItemWithIndex.sliceIndex]}
                        use:autoObserveItemResize
                        data-original-index={currentItemWithIndex.originalIndex}
                    >
                        {@render renderItem(
                            currentItemWithIndex.item,
                            currentItemWithIndex.originalIndex
                        )}
                    </div>
                {/each}
            </div>
        </div>
    </div>
</div>

<style>
    .virtual-list-container {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
    }

    .virtual-list-viewport {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        overflow-y: scroll;
        -webkit-overflow-scrolling: touch;
    }

    .virtual-list-content {
        position: relative;
        width: 100%;
        min-height: 100%;
    }

    .virtual-list-items {
        position: absolute;
        width: 100%;
        left: 0;
        top: 0;
    }

    .virtual-list-items > div {
        width: 100%;
        display: block;
    }
</style>
