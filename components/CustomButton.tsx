// components/CustomButton.tsx
import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { ButtonProps } from '@/types/type';

const CustomButton = ({
  onPress,
  title,
  IconLeft,
  IconRight,
  className = '',
  ...props
}: ButtonProps) => {
  return (
    <TouchableOpacity
      onPress={onPress}
      className={`
        bg-theme-light-input-background
        dark:bg-theme-dark-input-background
        p-4
        rounded-3xl
        mb-0.5
        flex
        flex-row
        justify-center
        items-center

        ${className}
      `}
      {...props}
    >
      {IconLeft && <IconLeft />}
      <Text
        className="
          text-xl
          font-semibold
          text-theme-light-text-primary
          dark:text-theme-dark-text-primary
        "
      >
        {title}
      </Text>
      {IconRight && <IconRight />}
    </TouchableOpacity>
  );
};

export default CustomButton;
