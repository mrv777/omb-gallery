"use client";

import React, { memo } from 'react';
import { ColorFilter } from '@/lib/types';

interface FilterControlsProps {
  colorFilter: ColorFilter;
  onColorFilterChange: (filter: ColorFilter) => void;
  searchQuery: string;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  columnCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

const FilterControls = memo(function FilterControls({
  colorFilter,
  onColorFilterChange,
  searchQuery,
  onSearchChange,
  columnCount,
  onZoomIn,
  onZoomOut,
  canZoomIn,
  canZoomOut,
}: FilterControlsProps) {
  return (
    <div className="filter-controls flex items-center gap-2 sm:gap-4">
      {/* Left: Color filters */}
      <div className="color-filters flex-shrink-0">
        <div className="flex space-x-1 sm:space-x-2">
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 ${
              colorFilter === 'all' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('all')}
            style={{ background: 'linear-gradient(to right, red, blue, green, orange, black)' }}
            aria-label="Show all colors"
          />
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 bg-red-600 ${
              colorFilter === 'red' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('red')}
            aria-label="Filter by red"
          />
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 bg-blue-600 ${
              colorFilter === 'blue' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('blue')}
            aria-label="Filter by blue"
          />
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 bg-green-600 ${
              colorFilter === 'green' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('green')}
            aria-label="Filter by green"
          />
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 bg-orange-500 ${
              colorFilter === 'orange' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('orange')}
            aria-label="Filter by orange"
          />
          <button
            className={`w-5 h-5 sm:w-6 sm:h-6 bg-black ${
              colorFilter === 'black' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('black')}
            aria-label="Filter by black"
          />
        </div>
      </div>

      {/* Center: Search box */}
      <div className="search-box flex-1 flex justify-center min-w-0">
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={onSearchChange}
          className="w-full max-w-md px-2 sm:px-4 py-1.5 sm:py-2 border border-gray-300 dark:border-gray-600 bg-transparent focus:outline-none focus:border-gray-500 dark:focus:border-gray-400 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 text-sm"
        />
      </div>

      {/* Right: Zoom controls */}
      <div className="zoom-controls flex-shrink-0 flex items-center gap-0.5 sm:gap-1">
        <button
          onClick={onZoomIn}
          disabled={!canZoomIn}
          className={`w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-base sm:text-lg font-bold transition-colors ${
            canZoomIn
              ? 'hover:border-gray-500 hover:text-gray-900 dark:hover:border-gray-400 dark:hover:text-white'
              : 'opacity-40 cursor-not-allowed'
          }`}
          aria-label="Zoom in (fewer columns)"
        >
          +
        </button>
        <span className="text-gray-600 dark:text-gray-400 text-xs sm:text-sm font-medium min-w-[28px] sm:min-w-[35px] text-center">
          {columnCount}
        </span>
        <button
          onClick={onZoomOut}
          disabled={!canZoomOut}
          className={`w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-base sm:text-lg font-bold transition-colors ${
            canZoomOut
              ? 'hover:border-gray-500 hover:text-gray-900 dark:hover:border-gray-400 dark:hover:text-white'
              : 'opacity-40 cursor-not-allowed'
          }`}
          aria-label="Zoom out (more columns)"
        >
          −
        </button>
      </div>
    </div>
  );
});

export default FilterControls;
