"use client";

import React, { memo } from 'react';
import { ColorFilter } from '@/lib/types';

interface FilterControlsProps {
  colorFilter: ColorFilter;
  onColorFilterChange: (filter: ColorFilter) => void;
  searchQuery: string;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const FilterControls = memo(function FilterControls({
  colorFilter,
  onColorFilterChange,
  searchQuery,
  onSearchChange,
}: FilterControlsProps) {
  return (
    <div className="filter-controls flex flex-col md:flex-row justify-between items-center mb-4 p-2 gap-2 dark:bg-gray-800">
      <div className="color-filters mb-2 md:mb-0">
        <div className="flex space-x-2">
          <button
            className={`w-6 h-6 rounded-full ${
              colorFilter === 'all' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('all')}
            style={{ background: 'linear-gradient(to right, red, blue, green, orange, black)' }}
            aria-label="Show all colors"
          />
          <button
            className={`w-6 h-6 rounded-full bg-red-600 ${
              colorFilter === 'red' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('red')}
            aria-label="Filter by red"
          />
          <button
            className={`w-6 h-6 rounded-full bg-blue-600 ${
              colorFilter === 'blue' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('blue')}
            aria-label="Filter by blue"
          />
          <button
            className={`w-6 h-6 rounded-full bg-green-600 ${
              colorFilter === 'green' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('green')}
            aria-label="Filter by green"
          />
          <button
            className={`w-6 h-6 rounded-full bg-orange-500 ${
              colorFilter === 'orange' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('orange')}
            aria-label="Filter by orange"
          />
          <button
            className={`w-6 h-6 rounded-full bg-black ${
              colorFilter === 'black' ? 'ring-2 ring-gray-500 dark:ring-gray-300' : ''
            }`}
            onClick={() => onColorFilterChange('black')}
            aria-label="Filter by black"
          />
        </div>
      </div>
      <div className="search-box">
        <input
          type="text"
          placeholder="Search images..."
          value={searchQuery}
          onChange={onSearchChange}
          className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
        />
      </div>
    </div>
  );
});

export default FilterControls;
