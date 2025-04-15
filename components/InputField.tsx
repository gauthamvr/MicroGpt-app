// components/InputField.tsx
import {
  TextInput,
  View,
  Text,
  Image,
  KeyboardAvoidingView,
  TouchableWithoutFeedback,
  Keyboard,
  Platform,
} from 'react-native';

import { InputFieldProps } from '@/types/type';

/**
 * InputField styled to match the CustomButton for consistent theming.
 */
const InputField = ({
  label,
  icon,
  secureTextEntry = false,
  labelStyle,
  containerStyle,
  inputStyle,
  iconStyle,
  className,
  ...props
}: InputFieldProps) => {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View className={`my-1 w-full ${className}`}>
          {/* Label */}
          <Text
            className={`
              text-xl
              font-JakartaSemiBold
              mt-2
              mb-2
              text-theme-light-text-primary
              dark:text-theme-dark-text-primary
              ${labelStyle}
            `}
          >
            {label}
          </Text>

          {/* Container for icon + input */}
          <View
            className={`
              flex
              flex-row
              justify-start
              items-center
              relative
              bg-theme-light-input-background
              dark:bg-theme-dark-input-background
              rounded-3xl
              p-4
              ${containerStyle}
            `}
          >
            {icon && (
              <Image source={icon} className={`w-6 h-6 mr-4 ${iconStyle}`} />
            )}

            {/* Text Input */}
            <TextInput
              className={`
                flex-1
                font-normal
                text-xl
                text-theme-light-input-text
                dark:text-theme-dark-input-text
                ${inputStyle}
              `}
              secureTextEntry={secureTextEntry}
              {...props}
            />
          </View>
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
};

export default InputField;
